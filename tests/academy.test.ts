import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AcademyDatabase, registerAcademy, SnapshotSchema, type AcademySnapshot } from "../src/academy/service.js";

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
});
