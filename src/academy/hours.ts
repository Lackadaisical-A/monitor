import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AcademyDatabase } from "./service.js";

const prefix = "/api/academy/v1/hours";
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const uuid = z.string().uuid();
const instant = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Esri World Geocoding PointAddress match for 118 Ferry St, verified Nov 7, 2026.
// The academy website's JSON-LD coordinate is unrelated to this street address.
export const academyEntrance = { latitude: 40.741872424605, longitude: -74.051032864512 };
export const defaultHoursSite = { ...academyEntrance, address: "118 Ferry Street, Jersey City, NJ 07307", radiusFeet: 100, revision: 0 };
type HoursSite = typeof defaultHoursSite;
export const LocationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().positive(), capturedAt: instant, simulated: z.boolean(), precise: z.boolean(),
}).strict();
type Location = z.infer<typeof LocationSchema>;
type Check = { distanceMeters: number; accuracyMeters: number; siteRevision: number; radiusFeet: number };
type Adjustment = { actor: string; at: number; reason: string; previousStart: number; previousEnd: number | null };
export type HoursShift = { id: string; account: string; startedAt: number; endedAt: number | null; version: number; check: Check | null; adjustments: Adjustment[]; manualReason: string | null };
type Row = { payload: string };
type Actor = { email: string; role: string };

export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude), dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function validateHoursLocation(location: Location, now: number) {
  if (location.simulated) throw fail(400, "A simulated location cannot be used to clock in. Use your iPhone at the academy.");
  if (!location.precise) throw fail(400, "Enable Precise Location for Flight Academy in iPhone Settings, then try again.");
  if (now - location.capturedAt > 30_000 || location.capturedAt - now > 10_000) throw fail(400, "Your location is out of date. Check your iPhone's date and time, then try again.");
  if (location.accuracy > 20) throw fail(400, "Your location is not accurate enough yet. Move near the entrance or a window and try again.");
}

export function registerHours(app: FastifyInstance, db: AcademyDatabase, authorize: (req: FastifyRequest) => Actor, staff: Record<string, string>) {
  db.db.exec(`CREATE TABLE IF NOT EXISTS academy_hours (id TEXT PRIMARY KEY, account TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, payload TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS academy_hours_one_open ON academy_hours(account) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS academy_hours_dates ON academy_hours(started_at, ended_at);
    CREATE TABLE IF NOT EXISTS academy_hours_operations (account TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, shift_id TEXT NOT NULL, PRIMARY KEY(account, id));
    CREATE TABLE IF NOT EXISTS academy_hours_site (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS academy_hours_site_audit (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);`);
  const site = (): HoursSite => {
    const row = db.db.prepare("SELECT payload FROM academy_hours_site WHERE id=1").get() as Row | undefined;
    return row ? db.open<HoursSite>(row.payload) : { ...defaultHoursSite };
  };
  const shift = (id: string) => { const row = db.db.prepare("SELECT payload FROM academy_hours WHERE id=?").get(id) as Row | undefined; return row ? db.open<HoursShift>(row.payload) : undefined; };
  const save = (value: HoursShift) => db.db.prepare("INSERT INTO academy_hours VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at, ended_at=excluded.ended_at, payload=excluded.payload").run(value.id, value.account, value.startedAt, value.endedAt, db.seal(value));
  const admin = (actor: Actor) => { if (actor.role !== "admin") throw fail(403, "Only academy administrators can manage team hours."); };
  const retry = (actor: Actor, id: string, value: string) => {
    const digest = createHash("sha256").update(value).digest("hex");
    const row = db.db.prepare("SELECT digest, shift_id FROM academy_hours_operations WHERE account=? AND id=?").get(actor.email, id) as { digest: string; shift_id: string } | undefined;
    if (row && row.digest !== digest) throw fail(409, "This request was already used for another action. Refresh hours and try again.");
    return { existing: row ? shift(row.shift_id) : undefined, remember: (value: HoursShift) => db.db.prepare("INSERT INTO academy_hours_operations VALUES (?, ?, ?, ?)").run(actor.email, id, digest, value.id) };
  };
  const overlap = (account: string, start: number, end: number, excluding = "") => {
    if (db.db.prepare("SELECT id FROM academy_hours WHERE account=? AND id<>? AND started_at<? AND (ended_at IS NULL OR ended_at>?) LIMIT 1").get(account, excluding, end, start)) throw fail(409, "These hours overlap another shift for this instructor. Review the existing shift first.");
  };
  const range = z.object({ startedAt: instant, endedAt: instant, reason: z.string().trim().min(3).max(500) });
  const validateRange = (value: z.infer<typeof range>) => {
    const now = Date.now();
    if (value.endedAt - value.startedAt < 1000 || value.endedAt > now || value.startedAt < now - 366 * 86400_000 || value.endedAt - value.startedAt > 24 * 3600_000) throw fail(400, "Choose a completed shift in the past year lasting between one second and 24 hours.");
  };
  app.get(prefix, async (req, reply) => {
    const actor = authorize(req); reply.header("Cache-Control", "no-store");
    const now = Date.now();
    const query = z.object({ from: z.coerce.number().int().nonnegative().default(now - 30 * 86400_000), to: z.coerce.number().int().nonnegative().default(now + 1), team: z.enum(["true", "false"]).default("false") }).parse(req.query);
    if (query.to <= query.from || query.to - query.from > 93 * 86400_000) throw fail(400, "Choose a date range of up to 93 days.");
    const team = query.team === "true"; if (team) admin(actor);
    const rows = db.db.prepare(`SELECT payload FROM academy_hours WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) ${team ? "" : "AND account=?"} ORDER BY started_at DESC LIMIT 2001`).all(...(team ? [query.to, query.from] : [query.to, query.from, actor.email])) as Row[];
    if (rows.length > 2000) throw fail(400, "There are too many shifts in this range. Choose a shorter period.");
    const active = db.db.prepare("SELECT payload FROM academy_hours WHERE account=? AND ended_at IS NULL").get(actor.email) as Row | undefined;
    return { serverNow: now, account: actor.email, role: actor.role, team, site: site(), from: query.from, to: query.to, activeShift: active ? db.open<HoursShift>(active.payload) : null, shifts: rows.map(row => db.open<HoursShift>(row.payload)), staff: team ? Object.keys(staff).sort() : [actor.email] };
  });
  app.post(`${prefix}/clock-in`, async (req, reply) => {
    const actor = authorize(req); reply.header("Cache-Control", "no-store");
    const body = z.object({ operation: uuid, location: LocationSchema }).strict().parse(req.body);
    return db.db.transaction(() => {
      const operation = retry(actor, body.operation, "clock-in"); if (operation.existing) return { shift: operation.existing, serverNow: Date.now() };
      if (db.db.prepare("SELECT id FROM academy_hours WHERE account=? AND ended_at IS NULL").get(actor.email)) throw fail(409, "You are already clocked in. Refresh hours to see your current shift.");
      const now = Date.now(), currentSite = site(); validateHoursLocation(body.location, now);
      const distance = distanceMeters(currentSite, body.location);
      if (distance > currentSite.radiusFeet * 0.3048) throw fail(403, `You are about ${Math.ceil(distance / 0.3048)} feet from the academy pin. Move within ${currentSite.radiusFeet} feet of 118 Ferry Street to clock in.`);
      const value: HoursShift = { id: randomUUID(), account: actor.email, startedAt: now, endedAt: null, version: 1, check: { distanceMeters: Math.round(distance * 10) / 10, accuracyMeters: body.location.accuracy, siteRevision: currentSite.revision, radiusFeet: currentSite.radiusFeet }, adjustments: [], manualReason: null };
      save(value); operation.remember(value); return { shift: value, serverNow: now };
    })();
  });
  app.post(`${prefix}/clock-out`, async (req, reply) => {
    const actor = authorize(req); reply.header("Cache-Control", "no-store");
    const body = z.object({ operation: uuid, shiftID: uuid }).strict().parse(req.body);
    return db.db.transaction(() => {
      const operation = retry(actor, body.operation, `clock-out:${body.shiftID}`); if (operation.existing) return { shift: operation.existing, serverNow: Date.now() };
      const value = shift(body.shiftID);
      if (!value || value.account !== actor.email) throw fail(404, "This shift was not found.");
      const now = Date.now();
      if (value.endedAt === null) { value.endedAt = Math.max(now, value.startedAt); value.version++; save(value); }
      operation.remember(value); return { shift: value, serverNow: now };
    })();
  });
  app.post(`${prefix}/manual`, async (req, reply) => {
    const actor = authorize(req); admin(actor); reply.header("Cache-Control", "no-store");
    const body = range.extend({ operation: uuid, account: z.string() }).strict().parse(req.body);
    return db.db.transaction(() => {
      const operation = retry(actor, body.operation, JSON.stringify(body)); if (operation.existing) return { shift: operation.existing, serverNow: Date.now() };
      if (!Object.hasOwn(staff, body.account)) throw fail(400, "Choose an academy instructor.");
      validateRange(body); overlap(body.account, body.startedAt, body.endedAt);
      const value: HoursShift = { id: randomUUID(), account: body.account, startedAt: body.startedAt, endedAt: body.endedAt, version: 1, check: null, manualReason: body.reason, adjustments: [{ actor: actor.email, at: Date.now(), reason: body.reason, previousStart: body.startedAt, previousEnd: body.endedAt }] };
      save(value); operation.remember(value); return { shift: value, serverNow: Date.now() };
    })();
  });
  app.post(`${prefix}/shifts/:id/correct`, async (req, reply) => {
    const actor = authorize(req); admin(actor); reply.header("Cache-Control", "no-store");
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = range.extend({ operation: uuid, version: z.number().int().positive() }).strict().parse(req.body);
    return db.db.transaction(() => {
      const operation = retry(actor, body.operation, id + JSON.stringify(body)); if (operation.existing) return { shift: operation.existing, serverNow: Date.now() };
      const value = shift(id); if (!value) throw fail(404, "This shift was not found.");
      if (body.version !== value.version) throw fail(409, "This shift changed on another device. Refresh hours before editing it.");
      validateRange(body); overlap(value.account, body.startedAt, body.endedAt, value.id);
      if (value.adjustments.length >= 100) throw fail(400, "This shift has reached its correction limit. Contact the administrator.");
      value.adjustments.push({ actor: actor.email, at: Date.now(), reason: body.reason, previousStart: value.startedAt, previousEnd: value.endedAt });
      value.startedAt = body.startedAt; value.endedAt = body.endedAt; value.version++; save(value); operation.remember(value);
      return { shift: value, serverNow: Date.now() };
    })();
  });
  app.put(`${prefix}/site`, async (req, reply) => {
    const actor = authorize(req); admin(actor); reply.header("Cache-Control", "no-store");
    const body = z.object({ revision: z.number().int().nonnegative(), radiusFeet: z.union([z.literal(100), z.literal(150), z.literal(200)]), location: LocationSchema }).strict().parse(req.body);
    return db.db.transaction(() => {
      const before = site(); if (body.revision !== before.revision) throw fail(409, "The academy pin changed. Refresh hours and try again.");
      validateHoursLocation(body.location, Date.now());
      if (distanceMeters(academyEntrance, body.location) > 60) throw fail(403, "Stand at the entrance to 118 Ferry Street to verify the academy pin.");
      const next: HoursSite = { address: before.address, latitude: body.location.latitude, longitude: body.location.longitude, radiusFeet: body.radiusFeet, revision: before.revision + 1 };
      db.db.prepare("INSERT INTO academy_hours_site VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(db.seal(next));
      db.db.prepare("INSERT INTO academy_hours_site_audit(payload) VALUES (?)").run(db.seal({ actor: actor.email, at: Date.now(), before, after: next }));
      return { site: next };
    })();
  });
}
