import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerAcademy } from "../src/academy/service.js";
import { academyEntrance, distanceMeters } from "../src/academy/hours.js";

const root = "/api/academy/v1/hours";
const now = Date.parse("2026-11-07T18:00:00Z");
const location = (meters = 0, changes = {}) => ({ ...academyEntrance, latitude: academyEntrance.latitude + meters / 6_371_008.8 * 180 / Math.PI, accuracy: 5, capturedAt: Date.now(), simulated: false, precise: true, ...changes });
async function fixture(path = ":memory:") {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500).send({ message: (error as Error).message }));
  const db = await registerAcademy(app, { path, key: "ab".repeat(32), origin: "https://academy.example.com", staff: { teacher: "instructor", colleague: "instructor", director: "admin" } });
  const headers = Object.fromEntries(["teacher", "colleague", "director"].map(account => [account, { authorization: `Bearer ${db.session(account).token}` }]));
  const call = (path = "", account = "teacher", method: "GET" | "POST" | "PUT" = "GET", payload?: unknown) => app.inject({ url: root + path, method, headers: headers[account] ?? {}, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }), ...(payload === undefined ? {} : { headers: { ...headers[account], "content-type": "application/json" } }) });
  const clockIn = (account = "teacher", proof = location(), operation = randomUUID()) => call("/clock-in", account, "POST", { operation, location: proof });
  const manual = (start = now - 7200_000, end = now - 3600_000, account = "teacher") => call("/manual", "director", "POST", { operation: randomUUID(), account, startedAt: start, endedAt: end, reason: "Confirmed the missed shift with instructor" });
  return { app, db, call, clockIn, manual };
}
afterEach(() => vi.restoreAllMocks());

describe("instructor hours", () => {
  it("enforces staff authentication, identity, and admin-only access", async () => {
    const f = await fixture(); try {
      for (const [method, path] of [["GET", ""], ["POST", "/clock-in"], ["POST", "/clock-out"], ["POST", "/manual"], ["PUT", "/site"], ["POST", `/shifts/${randomUUID()}/correct`]] as const) expect((await f.call(path, "missing", method)).statusCode).toBe(401);
      expect((await f.call("?team=true")).statusCode).toBe(403);
      expect((await f.call("/manual", "teacher", "POST", {})).statusCode).toBe(403);
      expect((await f.call("/site", "teacher", "PUT", {})).statusCode).toBe(403);
      expect((await f.call(`/shifts/${randomUUID()}/correct`, "teacher", "POST", {})).statusCode).toBe(403);
      const a = (await f.clockIn()).json().shift; await f.clockIn("colleague");
      expect((await f.call()).json().shifts.map((s: { account: string }) => s.account)).toEqual(["teacher"]);
      expect((await f.call("?team=true", "director")).json().shifts).toHaveLength(2);
      expect((await f.call("/clock-out", "colleague", "POST", { operation: randomUUID(), shiftID: a.id })).statusCode).toBe(404);
      expect((await f.call("/clock-in", "teacher", "POST", { operation: randomUUID(), account: "director", location: location() })).statusCode).toBe(400);
    } finally { await f.app.close(); }
  });
  it("accepts the inside of the 100-foot boundary and rejects the outside", async () => {
    const f = await fixture(); try {
      expect(distanceMeters(academyEntrance, location(30.47))).toBeCloseTo(30.47, 3);
      expect((await f.clockIn("teacher", location(30.49))).statusCode).toBe(403);
      const accepted = await f.clockIn("teacher", location(30.47)); expect(accepted.statusCode).toBe(200);
      expect(accepted.json().shift.check.radiusFeet).toBe(100);
      expect(accepted.json().shift.startedAt).toBe(now);
      expect((await f.call()).headers["cache-control"]).toBe("no-store");
    } finally { await f.app.close(); }
  });
  it("rejects weak, stale, approximate, invalid, and simulated location fixes without recording a shift", async () => {
    const f = await fixture(); try {
      for (const invalid of [{ accuracy: 20.01 }, { accuracy: 0 }, { accuracy: -1 }, { capturedAt: now - 30_001 }, { capturedAt: now + 10_001 }, { precise: false }, { simulated: true }, { latitude: 91 }, { longitude: -181 }]) expect((await f.clockIn("teacher", location(0, invalid))).statusCode).toBe(400);
      expect((await f.call()).json().shifts).toEqual([]);
      expect((await f.clockIn("teacher", location(0, { accuracy: 20, capturedAt: now - 30_000 }))).statusCode).toBe(200);
    } finally { await f.app.close(); }
  });
  it("keeps one open shift per instructor and makes retries safe even after clock-out", async () => {
    const f = await fixture(); try {
      const operation = randomUUID(), first = (await f.clockIn("teacher", location(), operation)).json().shift;
      expect((await f.clockIn("teacher", location(), operation)).json().shift.id).toBe(first.id);
      const duplicates = await Promise.all([f.clockIn(), f.clockIn()]); expect(duplicates.map(x => x.statusCode)).toEqual([409, 409]);
      vi.mocked(Date.now).mockReturnValue(now + 3600_000);
      const out = { operation: randomUUID(), shiftID: first.id };
      expect((await f.call("/clock-out", "teacher", "POST", out)).json().shift.endedAt).toBe(now + 3600_000);
      vi.mocked(Date.now).mockReturnValue(now + 7200_000);
      expect((await f.call("/clock-out", "teacher", "POST", out)).json().shift.endedAt).toBe(now + 3600_000);
      expect((await f.clockIn("teacher", location(), operation)).json().shift.endedAt).toBe(now + 3600_000);
      expect((await f.call("/clock-out", "teacher", "POST", { operation, shiftID: first.id })).statusCode).toBe(409);
      expect((await f.call()).json().activeShift).toBeNull();
      expect((await f.call()).json().shifts).toHaveLength(1);
    } finally { await f.app.close(); }
  });
  it("allows clock-out without location and encrypts records without retaining raw GPS coordinates", async () => {
    const f = await fixture(); try {
      const shift = (await f.clockIn()).json().shift;
      vi.mocked(Date.now).mockReturnValue(now + 2 * 3600_000);
      const result = await f.call("/clock-out", "teacher", "POST", { operation: randomUUID(), shiftID: shift.id });
      expect(result.statusCode).toBe(200); expect(result.json().shift.endedAt - shift.startedAt).toBe(2 * 3600_000);
      const row = f.db.db.prepare("SELECT payload FROM academy_hours").get() as { payload: string };
      expect(row.payload).not.toContain("teacher"); expect(row.payload).not.toContain(String(academyEntrance.latitude));
      const saved = f.db.open<Record<string, unknown>>(row.payload); expect(JSON.stringify(saved)).not.toContain("latitude"); expect(JSON.stringify(saved)).not.toContain("longitude");
      expect(saved.id).toBe(shift.id);
    } finally { await f.app.close(); }
  });
  it("keeps open shifts and hours history after the database is reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "academy-hours-")), path = join(directory, "academy.db");
    try {
      const first = await fixture(path); let id: string;
      try { id = (await first.clockIn()).json().shift.id; } finally { await first.app.close(); }
      const second = await fixture(path);
      try { expect((await second.call()).json().activeShift.id).toBe(id); expect((await second.call()).json().shifts).toHaveLength(1); }
      finally { await second.app.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("records admin corrections with previous times and rejects stale or overlapping edits", async () => {
    const f = await fixture(); try {
      const first = (await f.manual()).json().shift;
      expect((await f.manual(now - 5400_000, now - 1800_000)).statusCode).toBe(409);
      const body = { operation: randomUUID(), version: first.version, startedAt: now - 7100_000, endedAt: now - 3500_000, reason: "Corrected from the signed class register" };
      const result = await f.call(`/shifts/${first.id}/correct`, "director", "POST", body);
      expect(result.statusCode).toBe(200); expect(result.json().shift.adjustments.at(-1)).toMatchObject({ actor: "director", previousStart: first.startedAt, previousEnd: first.endedAt, reason: body.reason });
      expect((await f.call(`/shifts/${first.id}/correct`, "director", "POST", body)).json().shift.version).toBe(2);
      expect((await f.call(`/shifts/${first.id}/correct`, "director", "POST", { ...body, operation: randomUUID() })).statusCode).toBe(409);
      expect((await f.manual(now - 1000, now + 1000)).statusCode).toBe(400);
      expect((await f.manual(now - 1000, now - 2000)).statusCode).toBe(400);
      expect((await f.manual(now - 30 * 3600_000, now - 3600_000)).statusCode).toBe(400);
      expect((await f.manual(now - 10_000, now - 1000, "constructor")).statusCode).toBe(400);
    } finally { await f.app.close(); }
  });
  it("can correct a forgotten open shift and never automatically stops work", async () => {
    const f = await fixture(); try {
      const first = (await f.clockIn()).json().shift;
      vi.mocked(Date.now).mockReturnValue(now + 2 * 86400_000);
      expect((await f.call()).json().activeShift.id).toBe(first.id);
      const result = await f.call(`/shifts/${first.id}/correct`, "director", "POST", { operation: randomUUID(), version: 1, startedAt: now, endedAt: now + 3 * 3600_000, reason: "Instructor forgot to clock out after class" });
      expect(result.statusCode).toBe(200); expect(result.json().shift.adjustments[0].previousEnd).toBeNull();
      expect((await f.call()).json().activeShift).toBeNull(); expect((await f.clockIn()).statusCode).toBe(200);
    } finally { await f.app.close(); }
  });
  it("includes shifts overlapping the reporting window and returns an older active shift", async () => {
    const f = await fixture(); try {
      await f.manual();
      const report = (await f.call(`?from=${now - 5400_000}&to=${now - 1800_000}`)).json(); expect(report.shifts).toHaveLength(1);
      expect((await f.call(`?from=${now - 3600_000}&to=${now - 1800_000}`)).json().shifts).toHaveLength(0);
      expect((await f.call(`?from=${now}&to=${now}`)).statusCode).toBe(400);
      expect((await f.call(`?from=0&to=${now}`)).statusCode).toBe(400);
      await f.clockIn();
      expect((await f.call(`?from=${now - 86400_000}&to=${now - 1}`)).json().activeShift).not.toBeNull();
    } finally { await f.app.close(); }
  });
  it("lets only an onsite admin calibrate the pin, records history, and enforces the updated radius", async () => {
    const f = await fixture(); try {
      const input = { revision: 0, radiusFeet: 150, location: location(10) };
      expect((await f.call("/site", "director", "PUT", { ...input, location: location(61) })).statusCode).toBe(403);
      expect((await f.call("/site", "director", "PUT", { ...input, location: location(0, { simulated: true }) })).statusCode).toBe(400);
      expect((await f.call("/site", "director", "PUT", { ...input, radiusFeet: 1000 })).statusCode).toBe(400);
      expect((await f.call("/site", "director", "PUT", input)).statusCode).toBe(200);
      expect((await f.call("/site", "director", "PUT", input)).statusCode).toBe(409);
      expect((await f.call()).json().site).toMatchObject({ radiusFeet: 150, revision: 1 });
      expect((await f.clockIn("teacher", location(55))).statusCode).toBe(200);
      expect((await f.clockIn("colleague", location(56))).statusCode).toBe(403);
      expect(f.db.db.prepare("SELECT count(*) AS n FROM academy_hours_site_audit").get()).toEqual({ n: 1 });
    } finally { await f.app.close(); }
  });
});
