import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import type { AcademyDatabase } from "./service.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const uuid = z.string().uuid();
export const ClassLogSchema = z.object({
  id: uuid, studentID: uuid, sessionID: z.string().min(1).max(100),
  classDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value),
  title: z.string().trim().min(1).max(150), accomplishments: z.string().max(4000),
  nextSteps: z.string().max(2000), privateNotes: z.string().max(4000),
  instructor: z.string().min(1).max(150), photoIDs: z.array(uuid).max(6),
  published: z.boolean(), createdAt: z.number().finite(), updatedAt: z.number().finite(),
}).superRefine((entry, ctx) => {
  if (new Set(entry.photoIDs).size !== entry.photoIDs.length) ctx.addIssue({ code: "custom", message: "Duplicate photo" });
  if (entry.published && !entry.accomplishments.trim()) ctx.addIssue({ code: "custom", message: "Add an accomplishment before sharing" });
});

type Photo = { student: string; payload: string; digest: string };
type FamilyLink = { student: string; createdAt: number; expires: number };

export function registerJournal(app: FastifyInstance, db: AcademyDatabase, authorize: (req: FastifyRequest) => { email: string }, origin: string) {
  const prefix = "/api/academy/v1";
  db.db.exec(`CREATE TABLE IF NOT EXISTS academy_photos (id TEXT PRIMARY KEY, student TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS academy_family_links (student TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const photo = (id: string) => db.db.prepare("SELECT student, payload, digest FROM academy_photos WHERE id = ?").get(id) as Photo | undefined;
  const studentExists = (id: string) => db.latest().snapshot?.workspace.students.some(student => student.id === id);
  const family = (req: FastifyRequest) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail(401, "Ask your instructor for a current family link.");
    const link = db.db.prepare("SELECT student, created_at AS createdAt, expires FROM academy_family_links WHERE digest = ? AND expires > ?").get(hash(token), Date.now()) as FamilyLink | undefined;
    if (!link || !studentExists(link.student)) throw fail(401, "This family link has expired or been revoked. Ask your instructor for a new link.");
    return link;
  };
  app.post(`${prefix}/photos/check`, { bodyLimit: 2_500_000 }, async (req, reply) => {
    authorize(req); reply.header("Cache-Control", "no-store");
    const body = z.object({ photos: z.array(z.object({ id: uuid, studentID: uuid })).max(20_000) }).parse(req.body);
    const present: string[] = [];
    for (const item of body.photos) {
      const found = db.db.prepare("SELECT student FROM academy_photos WHERE id = ?").get(item.id) as { student: string } | undefined;
      if (found && found.student !== item.studentID) throw fail(400, "A photo cannot be reused for a different student.");
      if (found) present.push(item.id);
    }
    return { present };
  });
  // Metadata never enters the shared workspace snapshots. Each photo is immutable,
  // encrypted separately, and bound to one student, including on family requests.
  app.post(`${prefix}/photos`, { bodyLimit: 1_500_000 }, async (req, reply) => {
    authorize(req); reply.header("Cache-Control", "no-store");
    const body = z.object({ id: uuid, studentID: uuid, data: z.string().max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).parse(req.body);
    const input = Buffer.from(body.data, "base64"), digest = hash(body.data);
    if (input.length > 1_000_000 || input[0] !== 0xff || input[1] !== 0xd8) throw fail(400, "Choose a JPEG photo under 1 MB.");
    const existing = photo(body.id);
    if (existing) {
      if (existing.student !== body.studentID || existing.digest !== digest) throw fail(409, "Photo identity already belongs to another upload.");
      return { ok: true };
    }
    let data: Buffer;
    try { data = await sharp(input, { limitInputPixels: 16_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer(); }
    catch { throw fail(400, "This photo could not be read. Choose another image."); }
    const payload = db.seal({ data: data.toString("base64") });
    db.db.transaction(() => {
      const concurrent = photo(body.id);
      if (concurrent) {
        if (concurrent.student !== body.studentID || concurrent.digest !== digest) throw fail(409, "Photo identity already belongs to another upload.");
        return;
      }
      const used = (db.db.prepare("SELECT COALESCE(SUM(length(payload)), 0) AS bytes FROM academy_photos").get() as { bytes: number }).bytes;
      if (used + payload.length > 512_000_000) throw fail(507, "Academy photo storage is full. Your photo stays on this iPhone; contact the administrator.");
      db.db.prepare("INSERT INTO academy_photos VALUES (?, ?, ?, ?, ?)").run(body.id, body.studentID, payload, digest, Date.now());
    })();
    return { ok: true };
  });
  app.get(`${prefix}/photos/:id`, async (req, reply) => {
    authorize(req); const { id } = z.object({ id: uuid }).parse(req.params), record = photo(id);
    if (!record) throw fail(404, "Photo is not available on the shared workspace yet.");
    reply.header("Cache-Control", "no-store");
    return db.open<{ data: string }>(record.payload);
  });
  app.get(`${prefix}/students/:id/family-link`, async (req, reply) => {
    authorize(req); const { id } = z.object({ id: uuid }).parse(req.params);
    if (!studentExists(id)) throw fail(404, "Sync this student first.");
    reply.header("Cache-Control", "no-store");
    const link = db.db.prepare("SELECT created_at AS createdAt, expires FROM academy_family_links WHERE student = ? AND expires > ?").get(id, Date.now());
    return { active: Boolean(link) };
  });
  app.post(`${prefix}/students/:id/family-link`, async (req, reply) => {
    const actor = authorize(req), { id } = z.object({ id: uuid }).parse(req.params);
    if (!studentExists(id)) throw fail(404, "Sync this student before creating a family link.");
    const token = randomBytes(32).toString("base64url"), expires = Date.now() + 365 * 86400_000;
    db.db.prepare("INSERT OR REPLACE INTO academy_family_links VALUES (?, ?, ?, ?)").run(id, hash(token), Date.now(), expires);
    db.audit(actor.email, `family-link-replaced:${id}`);
    reply.header("Cache-Control", "no-store");
    // Fragment credentials never appear in server access logs or referrer URLs.
    return { url: `${origin}/academy-family.html#${token}`, expires };
  });
  app.delete(`${prefix}/students/:id/family-link`, async req => {
    const actor = authorize(req), { id } = z.object({ id: uuid }).parse(req.params);
    db.db.prepare("DELETE FROM academy_family_links WHERE student = ?").run(id);
    db.audit(actor.email, `family-link-revoked:${id}`); return { ok: true };
  });
  app.get(`${prefix}/family/journal`, async (req, reply) => {
    const link = family(req), snapshot = db.latest().snapshot!;
    const { offset } = z.object({ offset: z.coerce.number().int().min(0).max(20_000).default(0) }).parse(req.query);
    const student = snapshot.workspace.students.find(student => student.id === link.student)!;
    const entries = (snapshot.teaching.classLogs ?? []).filter(entry => entry.studentID === link.student && entry.published)
      .sort((a, b) => b.classDate.localeCompare(a.classDate) || b.createdAt - a.createdAt);
    reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex, nofollow");
    return {
      studentName: typeof student.name === "string" ? student.name : "Your student",
      nextOffset: offset + 30 < entries.length ? offset + 30 : null,
      entries: entries.slice(offset, offset + 30)
        .map(entry => ({ id: entry.id, classDate: entry.classDate, title: entry.title, accomplishments: entry.accomplishments,
          nextSteps: entry.nextSteps, photoIDs: entry.photoIDs,
          course: snapshot.teaching.sessions.find(session => session.id === entry.sessionID)?.course ?? "Academy class" })),
    };
  });
  app.get(`${prefix}/family/photos/:id`, async (req, reply) => {
    const link = family(req), { id } = z.object({ id: uuid }).parse(req.params);
    const visible = db.latest().snapshot?.teaching.classLogs?.some(entry => entry.studentID === link.student && entry.published && entry.photoIDs.includes(id));
    const record = visible ? photo(id) : undefined;
    if (!record || record.student !== link.student) throw fail(404, "Photo is not available.");
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").type("image/jpeg");
    return Buffer.from(db.open<{ data: string }>(record.payload).data, "base64");
  });
}
