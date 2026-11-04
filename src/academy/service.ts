import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const staffSchema = z.record(z.string().email(), z.enum(["admin", "instructor"]));
const record = z.object({ id: z.string().min(1).max(100) }).passthrough();
const rows = z.array(record).max(20_000);
// Swift's complete local backup is the wire format. All arrays are bounded and
// record identities must be unique; the server never treats ranks as app roles.
export const SnapshotSchema = z.object({
  workspace: z.object({ students: rows, progress: rows, log: rows, curriculum: z.object({ abilities: rows, courses: rows }).passthrough() }).passthrough(),
  teaching: z.object({ projects: rows, homework: rows, goals: rows, evidence: rows, awards: rows, sessions: rows, instructors: z.array(z.string()).max(200), lessonEdits: z.record(z.string(), z.unknown()), courseEdits: z.record(z.string(), z.unknown()).optional() }).passthrough(),
}).superRefine((value, ctx) => {
  for (const list of [value.workspace.students, value.workspace.progress, value.workspace.log, value.teaching.projects, value.teaching.homework, value.teaching.goals, value.teaching.evidence, value.teaching.awards, value.teaching.sessions]) {
    if (new Set(list.map(x => x.id)).size !== list.length) ctx.addIssue({ code: "custom", message: "Duplicate record identity" });
  }
  const students = new Set(value.workspace.students.map(x => x.id));
  for (const list of [value.workspace.progress, value.workspace.log, value.teaching.homework, value.teaching.goals, value.teaching.evidence, value.teaching.awards]) {
    if (list.some(x => typeof x.studentID !== "string" || !students.has(x.studentID))) ctx.addIssue({ code: "custom", message: "Unknown student reference" });
  }
  for (const x of [...value.teaching.projects, ...value.teaching.sessions]) {
    if (!Array.isArray(x.studentIDs) || x.studentIDs.some(id => !students.has(id))) ctx.addIssue({ code: "custom", message: "Unknown team member" });
  }
});
export type AcademySnapshot = z.infer<typeof SnapshotSchema>;
export type AcademyConfig = { path: string; origin: string; clientID: string; clientSecret: string; key: string; staff: Record<string, "admin" | "instructor"> };
type Session = { email: string; expires: number };
type Version = { revision: number; payload: string };

export class AcademyDatabase {
  readonly db: Database.Database;
  private key: Buffer;
  constructor(path: string, key: string) {
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("ACADEMY_DATA_KEY must contain 32 random bytes encoded as hex");
    this.key = Buffer.from(key, "hex");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS academy_versions (revision INTEGER PRIMARY KEY, payload TEXT NOT NULL, actor TEXT NOT NULL, changed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS academy_operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS academy_sessions (token TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS academy_nfc (digest TEXT PRIMARY KEY, student TEXT UNIQUE NOT NULL);`);
  }
  seal(value: unknown) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  open(value: string): AcademySnapshot {
    const bytes = Buffer.from(value, "base64"), cipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
  }
  latest() {
    const row = this.db.prepare("SELECT revision, payload FROM academy_versions ORDER BY revision DESC LIMIT 1").get() as Version | undefined;
    return { revision: row?.revision ?? 0, snapshot: row ? this.open(row.payload) : null };
  }
  save(base: number, operation: string, snapshot: AcademySnapshot, actor: string) {
    return this.db.transaction(() => {
      const digest = hash(JSON.stringify(snapshot));
      const prior = this.db.prepare("SELECT revision, digest FROM academy_operations WHERE id = ?").get(operation) as { revision: number; digest: string } | undefined;
      if (prior) { if (prior.digest !== digest) throw fail(409, "Operation ID was reused with different data"); return { revision: prior.revision }; }
      const current = this.latest();
      if (current.revision !== base) throw fail(409, "Another instructor updated this workspace. Pull and review changes first.");
      const revision = base + 1;
      this.db.prepare("INSERT INTO academy_versions VALUES (?, ?, ?, ?)").run(revision, this.seal(snapshot), actor, Date.now());
      this.db.prepare("INSERT INTO academy_operations VALUES (?, ?, ?)").run(operation, digest, revision);
      return { revision };
    })();
  }
  session(email: string) {
    const token = opaque(), expires = Date.now() + 7 * 86400_000;
    this.db.prepare("DELETE FROM academy_sessions WHERE expires < ?").run(Date.now());
    this.db.prepare("INSERT INTO academy_sessions VALUES (?, ?, ?)").run(hash(token), email, expires);
    return { token, email, expires };
  }
  lookup(token: string): Session | undefined {
    return this.db.prepare("SELECT email, expires FROM academy_sessions WHERE token = ? AND expires > ?").get(hash(token), Date.now()) as Session | undefined;
  }
  tag(technology: string, identifier: string) { return createHmac("sha256", this.key).update(`academy-nfc-v1:${technology.toLowerCase()}:${identifier.toLowerCase()}`).digest("hex"); }
}

export async function registerAcademy(app: FastifyInstance, config: AcademyConfig) {
  const db = new AcademyDatabase(config.path, config.key);
  const staff = staffSchema.parse(config.staff);
  const origin = new URL(config.origin);
  if (origin.protocol !== "https:" || origin.pathname !== "/") throw new Error("Academy origin must be an HTTPS origin");
  const redirectURI = `${origin.origin}/api/academy/v1/auth/callback`;
  const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  const pending = new Map<string, { challenge: string; nonce: string; expiry: number; email?: string }>();
  const prefix = "/api/academy/v1";
  const authorize = (req: FastifyRequest) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const session = db.lookup(token);
    if (!session || !staff[session.email]) throw fail(401, "Sign in with an approved instructor account");
    return { ...session, role: staff[session.email]! };
  };
  app.addHook("onClose", async () => { db.db.close(); });
  app.get(`${prefix}/auth/start`, async (req, reply) => {
    const { challenge } = z.object({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(req.query);
    for (const [key, value] of pending) if (value.expiry < Date.now()) pending.delete(key);
    if (pending.size > 500) throw fail(429, "Try signing in again shortly");
    const state = opaque(), nonce = opaque();
    pending.set(state, { challenge, nonce, expiry: Date.now() + 300_000 });
    const params = new URLSearchParams({ client_id: config.clientID, redirect_uri: redirectURI, response_type: "code", scope: "openid email", state, nonce, prompt: "select_account" });
    return reply.header("Cache-Control", "no-store").redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });
  app.get(`${prefix}/auth/callback`, async (req, reply) => {
    const { state, code } = z.object({ state: z.string(), code: z.string() }).parse(req.query);
    const flow = pending.get(state);
    if (!flow || flow.expiry < Date.now() || flow.email) throw fail(401, "Sign-in expired; start again");
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: config.clientID, client_secret: config.clientSecret, redirect_uri: redirectURI, grant_type: "authorization_code" }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw fail(401, "Google sign-in was not accepted");
    const tokens = z.object({ id_token: z.string() }).parse(await response.json());
    const { payload } = await jwtVerify(tokens.id_token, googleKeys, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: config.clientID });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (payload.nonce !== flow.nonce || payload.email_verified !== true || !staff[email]) { pending.delete(state); throw fail(403, "This Google account is not an approved academy instructor"); }
    flow.email = email;
    return reply.header("Cache-Control", "no-store").redirect(`flightacademy://auth?code=${encodeURIComponent(state)}`);
  });
  app.post(`${prefix}/auth/complete`, async req => {
    const body = z.object({ code: z.string(), verifier: z.string().min(43).max(128) }).parse(req.body);
    const flow = pending.get(body.code);
    const challenge = createHash("sha256").update(body.verifier).digest("base64url");
    if (!flow?.email || flow.expiry < Date.now() || challenge !== flow.challenge) throw fail(401, "Sign-in could not be verified");
    pending.delete(body.code);
    return { ...db.session(flow.email), role: staff[flow.email] };
  });
  app.post(`${prefix}/auth/logout`, async req => {
    authorize(req); db.db.prepare("DELETE FROM academy_sessions WHERE token = ?").run(hash(req.headers.authorization!.slice(7))); return { ok: true };
  });
  app.get(`${prefix}/workspace`, async (req, reply) => { const actor = authorize(req); reply.header("Cache-Control", "no-store"); return { ...db.latest(), email: actor.email, role: actor.role }; });
  app.put(`${prefix}/workspace`, { bodyLimit: 15_000_000 }, async req => {
    const actor = authorize(req);
    const body = z.object({ revision: z.number().int().nonnegative(), operation: z.string().uuid(), snapshot: SnapshotSchema }).parse(req.body);
    const previous = db.latest();
    if (actor.role !== "admin") {
      if (!previous.snapshot || JSON.stringify(previous.snapshot.workspace.curriculum) !== JSON.stringify(body.snapshot.workspace.curriculum) || JSON.stringify(previous.snapshot.teaching.lessonEdits) !== JSON.stringify(body.snapshot.teaching.lessonEdits) || JSON.stringify(previous.snapshot.teaching.courseEdits) !== JSON.stringify(body.snapshot.teaching.courseEdits)) throw fail(403, "Curriculum changes and workspace setup require an administrator");
    }
    // Portable snapshots never transfer device-specific fingerprints.
    for (const student of body.snapshot.workspace.students) delete student.passportFingerprint;
    return db.save(body.revision, body.operation, body.snapshot, actor.email);
  });
  const tagSchema = z.object({ technology: z.string().regex(/^[a-zA-Z0-9_-]{2,30}$/), identifier: z.string().regex(/^(?:[a-fA-F0-9]{2}){2,64}$/) });
  app.post(`${prefix}/passports/identify`, async req => { authorize(req); const tag = tagSchema.parse(req.body); const row = db.db.prepare("SELECT student FROM academy_nfc WHERE digest = ?").get(db.tag(tag.technology, tag.identifier)) as { student: string } | undefined; if (!row) throw fail(404, "Passport is not linked"); return { studentID: row.student }; });
  app.post(`${prefix}/passports/link`, async req => {
    authorize(req); const body = tagSchema.extend({ studentID: z.string().uuid() }).parse(req.body);
    if (!db.latest().snapshot?.workspace.students.some(x => x.id === body.studentID)) throw fail(404, "Sync this student before linking a passport");
    const digest = db.tag(body.technology, body.identifier);
    db.db.transaction(() => { const existing = db.db.prepare("SELECT student FROM academy_nfc WHERE digest = ?").get(digest) as { student: string } | undefined; if (existing && existing.student !== body.studentID) throw fail(409, "Passport is already assigned to another student"); db.db.prepare("DELETE FROM academy_nfc WHERE student = ?").run(body.studentID); db.db.prepare("INSERT OR REPLACE INTO academy_nfc VALUES (?, ?)").run(digest, body.studentID); })();
    return { ok: true };
  });
  return db;
}

export async function registerAcademyFromEnvironment(app: FastifyInstance, env = process.env) {
  if (!env.ACADEMY_ORIGIN) return; // Explicitly disconnected until deployment is configured.
  if (!env.ACADEMY_GOOGLE_CLIENT_ID || !env.ACADEMY_GOOGLE_CLIENT_SECRET || !env.ACADEMY_DATA_KEY || !env.ACADEMY_STAFF_JSON || !env.ACADEMY_DATABASE_PATH) throw new Error("Academy shared workspace configuration is incomplete");
  await registerAcademy(app, { path: env.ACADEMY_DATABASE_PATH, origin: env.ACADEMY_ORIGIN, clientID: env.ACADEMY_GOOGLE_CLIENT_ID, clientSecret: env.ACADEMY_GOOGLE_CLIENT_SECRET, key: env.ACADEMY_DATA_KEY, staff: JSON.parse(env.ACADEMY_STAFF_JSON) });
}
