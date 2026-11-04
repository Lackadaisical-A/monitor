import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerAcademy, SnapshotSchema } from "../src/academy/service.js";

const prefix = "/api/academy/v1";
async function fixture() {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500).send({ message: (error as Error).message }));
  const db = await registerAcademy(app, { path: ":memory:", key: "ab".repeat(32), origin: "https://academy.example.com", staff: { teacher: "instructor", director: "admin" } });
  const alice = randomUUID(), bob = randomUUID();
  const state = SnapshotSchema.parse({ workspace: { students: [{ id: alice, name: "Alice Example" }, { id: bob, name: "Bob Example" }], progress: [], log: [], curriculum: { abilities: [], courses: [] } }, teaching: { projects: [], homework: [], goals: [], evidence: [], awards: [], sessions: [{ id: "class-a", course: "Aircraft Design", studentIDs: [alice, bob] }], instructors: [], lessonEdits: {} } });
  db.save(0, randomUUID(), state, "director");
  const headers = { authorization: `Bearer ${db.session("teacher").token}` };
  const entry = (studentID: string, published = false) => ({ id: randomUUID(), studentID, sessionID: "class-a", classDate: "2026-11-04", title: "A stronger wing", accomplishments: "Built and tested a wing spar.", nextSteps: "Compare two materials.", privateNotes: "PRIVATE teaching note", instructor: "teacher", photoIDs: [] as string[], published, createdAt: 815_529_600, updatedAt: 815_529_600 });
  const save = async (snapshot = state) => app.inject({ method: "PUT", url: `${prefix}/workspace`, headers, payload: { revision: db.latest().revision, operation: randomUUID(), snapshot } });
  const link = async (studentID: string) => {
    const response = await app.inject({ method: "POST", url: `${prefix}/students/${studentID}/family-link`, headers });
    expect(response.statusCode).toBe(200); const token = new URL(response.json().url).hash.slice(1);
    return { token, headers: { authorization: `Bearer ${token}` } };
  };
  const jpeg = await sharp({ create: { width: 48, height: 32, channels: 3, background: "#0e2a47" } }).withMetadata().jpeg().toBuffer();
  const upload = async (studentID: string, id = randomUUID()) => {
    const response = await app.inject({ method: "POST", url: `${prefix}/photos`, headers, payload: { id, studentID, data: jpeg.toString("base64") } });
    expect(response.statusCode).toBe(200); return id;
  };
  return { app, db, state, alice, bob, entry, headers, save, link, jpeg, upload };
}

describe("class journals and private family updates", () => {
  it("requires instructor authentication for logs, photo uploads, and family link management", async () => {
    const f = await fixture();
    try {
      for (const [method, path] of [["POST", "/photos"], ["POST", "/photos/check"], ["GET", `/photos/${randomUUID()}`], ["POST", `/students/${f.alice}/family-link`], ["DELETE", `/students/${f.alice}/family-link`]] as const) {
        expect((await f.app.inject({ method, url: prefix + path })).statusCode).toBe(401);
      }
      const family = await f.link(f.alice);
      expect((await f.app.inject({ url: `${prefix}/workspace`, headers: family.headers })).statusCode).toBe(401);
      expect((await f.app.inject({ method: "POST", url: `${prefix}/students/${f.bob}/family-link`, headers: family.headers })).statusCode).toBe(401);
      expect((await f.app.inject({ url: `${prefix}/family/journal`, headers: f.headers })).statusCode).toBe(401);
    } finally { await f.app.close(); }
  });
  it("shows only one student's published work and never exposes private notes, roster, or drafts", async () => {
    const f = await fixture();
    try {
      const draft = f.entry(f.alice), published = f.entry(f.alice, true), other = f.entry(f.bob, true);
      draft.title = "PRIVATE draft"; other.title = "OTHER STUDENT";
      f.state.teaching.classLogs = [draft, published, other]; expect((await f.save()).statusCode).toBe(200);
      const family = await f.link(f.alice);
      const response = await f.app.inject({ url: `${prefix}/family/journal`, headers: family.headers });
      expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json().studentName).toBe("Alice Example"); expect(response.json().entries.map((x: { id: string }) => x.id)).toEqual([published.id]);
      for (const secret of ["PRIVATE", "OTHER STUDENT", "Bob Example", "privateNotes", "studentID", "instructor", "workspace"]) expect(response.body).not.toContain(secret);
      expect(JSON.stringify(f.db.db.prepare("SELECT * FROM academy_family_links").all())).not.toContain(family.token);
      const stored = JSON.stringify(f.db.db.prepare("SELECT payload FROM academy_versions").all()); expect(stored).not.toContain("Built and tested");
    } finally { await f.app.close(); }
  });
  it("encrypts and sanitizes photos, retries uploads, and prevents cross-student or unpublished photo access", async () => {
    const f = await fixture();
    try {
      const photo = await f.upload(f.alice), bobPhoto = await f.upload(f.bob), draftPhoto = await f.upload(f.alice);
      await f.upload(f.alice, photo);
      const visible = f.entry(f.alice, true); visible.photoIDs = [photo];
      const hidden = f.entry(f.alice); hidden.photoIDs = [draftPhoto];
      const other = f.entry(f.bob, true); other.photoIDs = [bobPhoto];
      f.state.teaching.classLogs = [visible, hidden, other]; expect((await f.save()).statusCode).toBe(200);
      const family = await f.link(f.alice);
      const response = await f.app.inject({ url: `${prefix}/family/photos/${photo}`, headers: family.headers });
      expect(response.statusCode).toBe(200); expect(response.headers["content-type"]).toBe("image/jpeg"); expect(response.headers["cache-control"]).toBe("no-store");
      expect((await sharp(response.rawPayload).metadata()).exif).toBeUndefined();
      for (const id of [bobPhoto, draftPhoto, randomUUID()]) expect((await f.app.inject({ url: `${prefix}/family/photos/${id}`, headers: family.headers })).statusCode).toBe(404);
      const encrypted = JSON.stringify(f.db.db.prepare("SELECT payload FROM academy_photos").all()); expect(encrypted).not.toContain(f.jpeg.toString("base64"));
      visible.photoIDs = [bobPhoto]; expect((await f.save()).statusCode).toBe(400);
      visible.photoIDs = [randomUUID()]; expect((await f.save()).statusCode).toBe(400);
      expect((await f.app.inject({ method: "POST", url: `${prefix}/photos/check`, headers: f.headers, payload: { photos: [{ id: photo, studentID: f.bob }] } })).statusCode).toBe(400);
      visible.photoIDs = [photo]; visible.published = false; expect((await f.save()).statusCode).toBe(200);
      expect((await f.app.inject({ url: `${prefix}/family/photos/${photo}`, headers: family.headers })).statusCode).toBe(404);
    } finally { await f.app.close(); }
  });
  it("revokes replaced, deleted, and expired links immediately", async () => {
    const f = await fixture();
    try {
      const first = await f.link(f.alice), second = await f.link(f.alice);
      expect((await f.app.inject({ url: `${prefix}/family/journal`, headers: first.headers })).statusCode).toBe(401);
      expect((await f.app.inject({ url: `${prefix}/family/journal`, headers: second.headers })).statusCode).toBe(200);
      await f.app.inject({ method: "DELETE", url: `${prefix}/students/${f.alice}/family-link`, headers: f.headers });
      expect((await f.app.inject({ url: `${prefix}/family/journal`, headers: second.headers })).statusCode).toBe(401);
      const expired = await f.link(f.alice); f.db.db.prepare("UPDATE academy_family_links SET expires = 0").run();
      expect((await f.app.inject({ url: `${prefix}/family/journal`, headers: expired.headers })).statusCode).toBe(401);
    } finally { await f.app.close(); }
  });
  it("preserves journals when an older app syncs and validates dated class membership", async () => {
    const f = await fixture();
    try {
      const entry = f.entry(f.alice); f.state.teaching.classLogs = [entry]; expect((await f.save()).statusCode).toBe(200);
      delete f.state.teaching.classLogs; expect((await f.save()).statusCode).toBe(200);
      expect(f.db.latest().snapshot?.teaching.classLogs).toEqual([entry]);
      f.state.teaching.classLogs = [{ ...entry, classDate: "2026-02-30" }]; expect((await f.save()).statusCode).toBe(400);
      f.state.teaching.classLogs = [{ ...entry, sessionID: "unknown" }]; expect((await f.save()).statusCode).toBe(400);
      f.state.teaching.classLogs = [{ ...entry, published: true, accomplishments: " " }]; expect((await f.save()).statusCode).toBe(400);
      f.state.teaching.classLogs = []; expect((await f.save()).statusCode).toBe(200); expect(f.db.latest().snapshot?.teaching.classLogs).toEqual([]);
    } finally { await f.app.close(); }
  });
});
