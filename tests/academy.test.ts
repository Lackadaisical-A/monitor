import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcademyDatabase, registerAcademy, SnapshotSchema, accessCodeDigest, type AcademySnapshot } from "../src/academy/service.js";

const key = "ab".repeat(32);
const student = randomUUID();
function snapshot(): AcademySnapshot {
  return SnapshotSchema.parse({ workspace: { students: [{ id: student, name: "Sample Student" }], progress: [], log: [], curriculum: { abilities: [], courses: [] } }, teaching: { projects: [], homework: [], goals: [], evidence: [], awards: [], sessions: [], instructors: [], lessonEdits: {} } });
}
describe("academy private workspace", () => {
  it("encrypts snapshots and makes retries idempotent without accepting stale writes", () => {
    const db = new AcademyDatabase(":memory:", key), data = snapshot(), operation = randomUUID();
    try {
      expect(db.save(0, operation, data, "admin@example.com")).toEqual({ revision: 1 });
      expect(db.save(0, operation, data, "admin@example.com")).toEqual({ revision: 1 });
      expect(() => db.save(0, randomUUID(), data, "admin@example.com")).toThrow(/updated/);
      expect(db.latest().snapshot).toEqual(data);
      const stored = db.db.prepare("SELECT payload FROM academy_versions").get() as { payload: string };
      expect(stored.payload).not.toContain("Sample Student");
      const tampered = Buffer.from(stored.payload, "base64"); tampered[35] = tampered[35]! ^ 1;
      expect(() => db.open(tampered.toString("base64"))).toThrow();
      data.teaching.instructors.push("A");
      expect(() => db.save(0, operation, data, "admin@example.com")).toThrow(/reused/);
    } finally { db.db.close(); }
  });
  it("rejects dangling student references and duplicated identities", () => {
    const data = snapshot(); data.teaching.goals.push({ id: randomUUID(), studentID: randomUUID() });
    expect(() => SnapshotSchema.parse(data)).toThrow();
    const duplicate = snapshot(); duplicate.workspace.students.push(duplicate.workspace.students[0]!);
    expect(() => SnapshotSchema.parse(duplicate)).toThrow();
  });
  it("requires approved staff, gates curriculum edits, and expires sessions", async () => {
    const app = Fastify();
    const db = await registerAcademy(app, { path: ":memory:", origin: "https://academy.example.com", clientID: "test", clientSecret: "test", key, staff: { "admin@example.com": "admin", "teacher@example.com": "instructor" } });
    const admin = db.session("admin@example.com"), instructor = db.session("teacher@example.com"), outsider = db.session("outsider@example.com");
    const url = "/api/academy/v1/workspace";
    try {
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { authorization: `Bearer ${outsider.token}` } })).statusCode).toBe(401);
      const data = snapshot();
      expect((await app.inject({ method: "PUT", url, headers: { authorization: `Bearer ${instructor.token}` }, payload: { revision: 0, operation: randomUUID(), snapshot: data } })).statusCode).toBe(403);
      expect((await app.inject({ method: "PUT", url, headers: { authorization: `Bearer ${admin.token}` }, payload: { revision: 0, operation: randomUUID(), snapshot: data } })).statusCode).toBe(200);
      data.teaching.goals.push({ id: randomUUID(), studentID: student, title: "Practice" });
      expect((await app.inject({ method: "PUT", url, headers: { authorization: `Bearer ${instructor.token}` }, payload: { revision: 1, operation: randomUUID(), snapshot: data } })).statusCode).toBe(200);
      data.teaching.lessonEdits.test = {};
      expect((await app.inject({ method: "PUT", url, headers: { authorization: `Bearer ${instructor.token}` }, payload: { revision: 2, operation: randomUUID(), snapshot: data } })).statusCode).toBe(403);
      db.db.prepare("UPDATE academy_sessions SET expires = 0").run();
      expect((await app.inject({ url, headers: { authorization: `Bearer ${admin.token}` } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it("keeps tag IDs out of storage and prevents assigning one tag to two students", async () => {
    const app = Fastify();
    const db = await registerAcademy(app, { path: ":memory:", origin: "https://academy.example.com", clientID: "test", clientSecret: "test", key, staff: { "admin@example.com": "admin" } });
    const headers = { authorization: `Bearer ${db.session("admin@example.com").token}` };
    const data = snapshot(), other = randomUUID(); data.workspace.students.push({ id: other }); db.save(0, randomUUID(), data, "admin@example.com");
    const tag = { technology: "mifare", identifier: "aabbccddee" };
    try {
      expect((await app.inject({ method: "POST", url: "/api/academy/v1/passports/link", headers, payload: { ...tag, studentID: student } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/academy/v1/passports/link", headers, payload: { ...tag, studentID: other } })).statusCode).toBe(409);
      const identified = await app.inject({ method: "POST", url: "/api/academy/v1/passports/identify", headers, payload: tag });
      expect(identified.json()).toEqual({ studentID: student });
      expect(JSON.stringify(db.db.prepare("SELECT * FROM academy_nfc").all())).not.toContain(tag.identifier);
      expect((await app.inject({ method: "POST", url: "/api/academy/v1/auth/complete", payload: { code: "forged", verifier: "x".repeat(64) } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it("supports private codes without Google, preserves roles, and throttles guessing", async () => {
    const app = Fastify();
    const db = await registerAcademy(app, { path: ":memory:", origin: "https://academy.example.com", key, staff: { director: "admin", teacher: "instructor" }, codes: { director: accessCodeDigest("director", "ABCD-1234"), teacher: accessCodeDigest("teacher", "EFGH-5678") } });
    try {
      const result = await app.inject({ method: "POST", url: "/api/academy/v1/auth/code", payload: { account: " Director ", code: "abcd 1234" } });
      expect(result.statusCode).toBe(200); expect(result.json().role).toBe("admin");
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(JSON.stringify(db.db.prepare("SELECT * FROM academy_sessions").all())).not.toContain(result.json().token);
      expect((await app.inject({ url: "/api/academy/v1/auth/start?challenge=" + "x".repeat(43) })).statusCode).toBe(503);
      for (let i = 0; i < 29; i++) expect((await app.inject({ method: "POST", url: "/api/academy/v1/auth/code", payload: { account: "director", code: "wrong" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/academy/v1/auth/code", payload: { account: "director", code: "wrong" } })).statusCode).toBe(429);
    } finally { await app.close(); }
  });
  it("retains encrypted records across restart and invalidates sessions after code rotation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "academy-persistence-")), path = join(directory, "academy.db");
    const config = { path, origin: "https://academy.example.com", key, staff: { director: "admin" as const }, codes: { director: accessCodeDigest("director", "OLD-CODE") } };
    const first = Fastify(), db = await registerAcademy(first, config);
    db.save(0, randomUUID(), snapshot(), "director");
    const login = (await first.inject({ method: "POST", url: "/api/academy/v1/auth/code", payload: { account: "director", code: "OLD-CODE" } })).json();
    await first.close();
    const second = Fastify();
    try {
      await registerAcademy(second, { ...config, codes: { director: accessCodeDigest("director", "NEW-CODE") } });
      expect((await second.inject({ url: "/api/academy/v1/workspace", headers: { authorization: `Bearer ${login.token}` } })).statusCode).toBe(401);
      const next = (await second.inject({ method: "POST", url: "/api/academy/v1/auth/code", payload: { account: "director", code: "NEW-CODE" } })).json();
      const saved = (await second.inject({ url: "/api/academy/v1/workspace", headers: { authorization: `Bearer ${next.token}` } })).json();
      expect(saved.revision).toBe(1); expect(saved.snapshot.workspace.students[0].name).toBe("Sample Student");
    } finally { await second.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("activates only verified card setups, rejects public UIDs, and revokes card sessions", async () => {
    const app = Fastify();
    const db = await registerAcademy(app, { path: ":memory:", origin: "https://academy.example.com", key, staff: { director: "admin", teacher: "instructor", other: "instructor" } });
    const base = "/api/academy/v1/auth", teacher = { authorization: `Bearer ${db.session("teacher").token}` }, other = { authorization: `Bearer ${db.session("other").token}` }, admin = { authorization: `Bearer ${db.session("director").token}` };
    try {
      const pending = (await app.inject({ method: "POST", url: base + "/cards", headers: teacher })).json();
      expect(JSON.stringify(db.db.prepare("SELECT * FROM academy_staff_cards").all())).not.toContain(pending.token);
      expect((await app.inject({ method: "POST", url: base + "/card", payload: { token: pending.token } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: base + `/cards/${pending.id}/activate`, headers: other })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: base + `/cards/${pending.id}/activate`, headers: teacher })).statusCode).toBe(200);
      const signed = (await app.inject({ method: "POST", url: base + "/card", payload: { token: pending.token } })).json();
      expect(signed.role).toBe("instructor");
      const cardSession = { authorization: `Bearer ${signed.token}` };
      expect((await app.inject({ method: "POST", url: base + "/cards", headers: cardSession })).statusCode).toBe(403);
      expect((await app.inject({ url: base + "/cards", headers: other })).json().cards).toEqual([]);
      expect((await app.inject({ method: "DELETE", url: base + `/cards/${pending.id}`, headers: other })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: base + `/cards/${pending.id}`, headers: admin })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: base + "/card", payload: { token: pending.token } })).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/academy/v1/workspace", headers: cardSession })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: base + "/card", payload: { token: "a".repeat(43) } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it("expires unconfirmed cards and preserves the old card until replacement succeeds", async () => {
    const app = Fastify();
    const db = await registerAcademy(app, { path: ":memory:", origin: "https://academy.example.com", key, staff: { teacher: "instructor" } });
    const headers = { authorization: `Bearer ${db.session("teacher").token}` }, base = "/api/academy/v1/auth";
    try {
      const first = (await app.inject({ method: "POST", url: base + "/cards", headers })).json();
      await app.inject({ method: "POST", url: base + `/cards/${first.id}/activate`, headers });
      const next = (await app.inject({ method: "POST", url: base + "/cards", headers })).json();
      expect((await app.inject({ method: "POST", url: base + "/card", payload: { token: first.token } })).statusCode).toBe(200);
      db.db.prepare("UPDATE academy_staff_cards SET created_at = 0 WHERE id = ?").run(next.id);
      expect((await app.inject({ method: "POST", url: base + `/cards/${next.id}/activate`, headers })).statusCode).toBe(409);
      const replacement = (await app.inject({ method: "POST", url: base + "/cards", headers })).json();
      await app.inject({ method: "POST", url: base + `/cards/${replacement.id}/activate`, headers });
      expect((await app.inject({ method: "POST", url: base + "/card", payload: { token: first.token } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: base + "/card", payload: { token: replacement.token } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});
