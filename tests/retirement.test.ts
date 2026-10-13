import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SignalDatabase } from "../src/db.js";
import { MonitorPipeline } from "../src/pipeline.js";
import type { ClubAttendanceSheetSync } from "../src/club-sheets.js";

const clientToken = "a".repeat(64);
const developerKey = "developer-key-for-test-only-".repeat(2);
const clubKey = "club-key-for-test-only-".repeat(2);
const dataKey = "data-key-for-test-only-".repeat(2);
const config = () => loadConfig({ CATALYST_MONITOR_ENABLED: "false", BUYBACK_MONITOR_ENABLED: "false",
  DASHBOARD_TOKEN: "test-dashboard", LOG_LEVEL: "silent", CLUB_DATA_KEY: dataKey,
  CLUB_PAIRING_TOKEN: clubKey, DEVELOPER_PAIRING_TOKEN: developerKey });
let db: SignalDatabase | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("Catalyst retirement preserves attendance", () => {
  it("protects trading controls and accepts only a pause flag", async () => {
    db = new SignalDatabase(":memory:", dataKey);
    const setEntriesPaused = vi.fn(async () => {});
    const app = await createApp(config(), db, { run: vi.fn() } as unknown as MonitorPipeline, undefined, undefined, null,
      { snapshot: async () => ({ enabled: true, healthy: true, mode: "paper", account: "private" }), setEntriesPaused });
    const url = "/api/buyback/trading/control";
    expect((await app.inject({ method: "POST", url, payload: { entriesPaused: true } })).statusCode).toBe(401);
    const headers = { authorization: "Bearer test-dashboard" };
    expect((await app.inject({ method: "POST", url, headers, payload: { entriesPaused: true, mode: "live" } })).statusCode).toBe(400);
    expect(setEntriesPaused).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url, headers, payload: { entriesPaused: true } })).statusCode).toBe(200);
    expect(setEntriesPaused).toHaveBeenCalledWith(true);
    const health = (await app.inject({ method: "GET", url: "/api/buyback/health" })).json();
    expect(health.mode).toBe("paper");
    expect(health).not.toHaveProperty("account");
    await app.close();
  });
  it("cannot poll sources, invoke AI, or audit outcomes when retired", async () => {
    const dependencies = new Proxy({}, { get: () => { throw new Error("Retired dependency was invoked"); } });
    const pipeline = new MonitorPipeline(config(), dependencies as never, [dependencies as never], dependencies as never, dependencies as never, dependencies as never, dependencies as never);
    expect(await pipeline.run()).toMatchObject({ sourceCount: 0, analyzedCount: 0, errorCount: 0 });
    expect(await pipeline.requeueOutdatedAnalyses()).toBe(0);
    expect(await pipeline.reconcileStoredPolicies()).toMatchObject({ checkedCount: 0 });
  });

  it("blocks manual AI scans and keeps buyback details private", async () => {
    db = new SignalDatabase(":memory:", dataKey);
    const pipeline = { run: vi.fn() } as unknown as MonitorPipeline;
    const app = await createApp(config(), db, pipeline, undefined, undefined, null,
      { snapshot: async () => ({ enabled: true, healthy: false, events: [{ Ticker: "PRIVATE" }] }) });
    expect((await app.inject({ method: "POST", url: "/api/scan", headers: { authorization: "Bearer test-dashboard" } })).statusCode).toBe(410);
    expect(pipeline.run).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/api/buyback/status" })).statusCode).toBe(401);
    const health = await app.inject({ method: "GET", url: "/api/buyback/health" });
    expect(health.statusCode).toBe(503);
    expect(health.json()).not.toHaveProperty("events");
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    await app.close();
  });

  it("retains existing app authentication, club records and Sheets sync across restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "club-preservation-"));
    const path = join(dir, "existing.db");
    const id = randomUUID();
    const headers = { "x-installation-id": id, "x-client-token": clientToken };
    const sync = { requestSync: vi.fn() } as unknown as ClubAttendanceSheetSync;
    try {
      db = new SignalDatabase(path, dataKey);
      db.registerInstallation(id, createHash("sha256").update(clientToken).digest("hex"));
      db.activateDeveloperAccess(id);
      const event = db.createClubEvent("Existing club meeting", id);
      db.close(); db = new SignalDatabase(path, dataKey);
      const app = await createApp(config(), db, { run: vi.fn() } as unknown as MonitorPipeline, undefined, undefined, sync);
      const attendance = await app.inject({ method: "GET", url: "/api/developer/club", headers });
      expect(attendance.statusCode).toBe(200);
      expect(attendance.json().activeEvent.id).toBe(event.id);
      const close = await app.inject({ method: "POST", url: `/api/developer/club/events/${event.id}/close`, headers });
      expect(close.statusCode).toBe(200);
      expect(sync.requestSync).toHaveBeenCalledOnce();
      const status = await app.inject({ method: "GET", url: "/api/status", headers });
      expect(status.json().configuration).toMatchObject({ catalystEnabled: false, analysisMode: "Catalyst monitoring retired", model: "disabled", sourceCount: 0 });
      await app.close();
    } finally {
      db?.close(); db = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
