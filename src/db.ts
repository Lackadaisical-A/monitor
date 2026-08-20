import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  AlertTier,
  AnalysisRecord,
  DeviceRegistration,
  FeedEntry,
  ImpactAssessment,
  NormalizedItem,
  SourceTier,
  SourceType,
} from "./types.js";

interface ItemRow {
  id: string;
  external_id: string;
  source_id: string;
  source_name: string;
  source_type: SourceType;
  source_tier: SourceTier;
  headline: string;
  summary: string;
  url: string;
  author: string | null;
  published_at: string;
  discovered_at: string;
  company_hint: string | null;
  ticker_hint: string | null;
  raw_json: string;
  status: string;
}

interface AnalysisRow {
  item_id: string;
  model: string;
  method: "openai" | "heuristic_demo";
  assessment_json: string;
  policy_score: number;
  alert_tier: AlertTier;
  policy_reasons_json: string;
  created_at: string;
}

export class SignalDatabase {
  readonly sqlite: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new Database(path);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  insertItem(item: NormalizedItem): boolean {
    const result = this.sqlite.prepare(`
      INSERT OR IGNORE INTO items (
        id, external_id, source_id, source_name, source_type, source_tier,
        headline, summary, url, author, published_at, discovered_at,
        company_hint, ticker_hint, raw_json, status
      ) VALUES (
        @id, @externalId, @sourceId, @sourceName, @sourceType, @sourceTier,
        @headline, @summary, @url, @author, @publishedAt, @discoveredAt,
        @companyHint, @tickerHint, @rawJson, 'pending'
      )
    `).run({
      id: item.id,
      externalId: item.externalId,
      sourceId: item.source.id,
      sourceName: item.source.name,
      sourceType: item.source.type,
      sourceTier: item.source.tier,
      headline: item.headline,
      summary: item.summary,
      url: item.url,
      author: item.author,
      publishedAt: item.publishedAt,
      discoveredAt: item.discoveredAt,
      companyHint: item.companyHint,
      tickerHint: item.tickerHint,
      rawJson: JSON.stringify(item.raw),
    });
    return result.changes > 0;
  }

  saveAnalysis(record: AnalysisRecord): void {
    const transaction = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO analyses (
          item_id, model, method, assessment_json, policy_score,
          alert_tier, policy_reasons_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          model = excluded.model,
          method = excluded.method,
          assessment_json = excluded.assessment_json,
          policy_score = excluded.policy_score,
          alert_tier = excluded.alert_tier,
          policy_reasons_json = excluded.policy_reasons_json,
          created_at = excluded.created_at
      `).run(
        record.itemId,
        record.model,
        record.method,
        JSON.stringify(record.assessment),
        record.policyScore,
        record.alertTier,
        JSON.stringify(record.policyReasons),
        record.createdAt,
      );
      this.sqlite.prepare("UPDATE items SET status = 'analyzed' WHERE id = ?").run(record.itemId);
    });
    transaction();
  }

  markItem(itemId: string, status: "skipped" | "error"): void {
    this.sqlite.prepare("UPDATE items SET status = ? WHERE id = ?").run(status, itemId);
  }

  getItem(itemId: string): NormalizedItem | null {
    const row = this.sqlite.prepare("SELECT * FROM items WHERE id = ?").get(itemId) as ItemRow | undefined;
    return row ? rowToItem(row) : null;
  }

  getPendingItems(limit = 100): NormalizedItem[] {
    const rows = this.sqlite.prepare("SELECT * FROM items WHERE status = 'pending' ORDER BY published_at DESC LIMIT ?").all(limit) as ItemRow[];
    return rows.map(rowToItem);
  }

  findCorroboratingItems(item: NormalizedItem, sinceIso: string): NormalizedItem[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM items
      WHERE id <> ? AND published_at >= ?
        AND (
          (? IS NOT NULL AND ticker_hint = ?)
          OR (? IS NOT NULL AND company_hint = ?)
        )
      ORDER BY published_at DESC LIMIT 20
    `).all(
      item.id,
      sinceIso,
      item.tickerHint,
      item.tickerHint,
      item.companyHint,
      item.companyHint,
    ) as ItemRow[];
    return rows.map(rowToItem);
  }

  listFeed(limit = 100): FeedEntry[] {
    const rows = this.sqlite.prepare(`
      SELECT
        i.*,
        a.model, a.method, a.assessment_json, a.policy_score,
        a.alert_tier, a.policy_reasons_json, a.created_at,
        (SELECT COUNT(*) FROM items c
          WHERE c.id <> i.id AND c.published_at >= datetime(i.published_at, '-24 hours')
            AND ((i.ticker_hint IS NOT NULL AND c.ticker_hint = i.ticker_hint)
              OR (i.company_hint IS NOT NULL AND c.company_hint = i.company_hint))) AS corroboration_count,
        (SELECT MAX(sent_at) FROM alerts al WHERE al.item_id = i.id AND al.status IN ('sent', 'dry_run')) AS alerted_at
      FROM items i
      LEFT JOIN analyses a ON a.item_id = i.id
      WHERE i.status <> 'skipped'
      ORDER BY i.published_at DESC, i.discovered_at DESC
      LIMIT ?
    `).all(limit) as Array<ItemRow & Partial<AnalysisRow> & { corroboration_count: number; alerted_at: string | null }>;

    return rows.map((row) => ({
      item: rowToItem(row),
      analysis: row.assessment_json ? rowToAnalysis(row as ItemRow & AnalysisRow) : null,
      corroborationCount: row.corroboration_count,
      alertedAt: row.alerted_at,
    }));
  }

  getAnalysis(itemId: string): AnalysisRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM analyses WHERE item_id = ?").get(itemId) as AnalysisRow | undefined;
    return row ? rowToAnalysis(row) : null;
  }

  getSourceCursor(sourceId: string): string | null {
    const row = this.sqlite.prepare("SELECT cursor FROM source_state WHERE source_id = ?").get(sourceId) as { cursor: string | null } | undefined;
    return row?.cursor ?? null;
  }

  saveSourceState(sourceId: string, cursor: string | null, error: string | null, fetchedAt = new Date().toISOString()): void {
    this.sqlite.prepare(`
      INSERT INTO source_state (source_id, cursor, last_fetched_at, last_error)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        cursor = COALESCE(excluded.cursor, source_state.cursor),
        last_fetched_at = excluded.last_fetched_at,
        last_error = excluded.last_error
    `).run(sourceId, cursor, fetchedAt, error);
  }

  listSourceState(): Array<{ sourceId: string; cursor: string | null; lastFetchedAt: string | null; lastError: string | null }> {
    const rows = this.sqlite.prepare("SELECT * FROM source_state ORDER BY source_id").all() as Array<{
      source_id: string;
      cursor: string | null;
      last_fetched_at: string | null;
      last_error: string | null;
    }>;
    return rows.map((row) => ({ sourceId: row.source_id, cursor: row.cursor, lastFetchedAt: row.last_fetched_at, lastError: row.last_error }));
  }

  upsertDevice(device: DeviceRegistration): void {
    this.sqlite.prepare(`
      INSERT INTO devices (
        installation_id, device_token, environment, time_sensitive_authorized,
        critical_authorized, active, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(installation_id) DO UPDATE SET
        device_token = excluded.device_token,
        environment = excluded.environment,
        time_sensitive_authorized = excluded.time_sensitive_authorized,
        critical_authorized = excluded.critical_authorized,
        active = 1,
        updated_at = excluded.updated_at
    `).run(
      device.installationId,
      device.deviceToken.toLowerCase(),
      device.environment,
      device.timeSensitiveAuthorized ? 1 : 0,
      device.criticalAuthorized ? 1 : 0,
      new Date().toISOString(),
    );
  }

  listDevices(): Array<DeviceRegistration & { active: boolean }> {
    const rows = this.sqlite.prepare("SELECT * FROM devices WHERE active = 1 ORDER BY updated_at DESC").all() as Array<{
      installation_id: string;
      device_token: string;
      environment: "sandbox" | "production";
      time_sensitive_authorized: number;
      critical_authorized: number;
      active: number;
    }>;
    return rows.map((row) => ({
      installationId: row.installation_id,
      deviceToken: row.device_token,
      environment: row.environment,
      timeSensitiveAuthorized: Boolean(row.time_sensitive_authorized),
      criticalAuthorized: Boolean(row.critical_authorized),
      active: Boolean(row.active),
    }));
  }

  deactivateDevice(deviceToken: string): void {
    this.sqlite.prepare("UPDATE devices SET active = 0, updated_at = ? WHERE device_token = ?").run(new Date().toISOString(), deviceToken.toLowerCase());
  }

  hasRecentAlert(ticker: string, eventType: string, sinceIso: string): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 FROM alerts
      WHERE ticker = ? AND event_type = ? AND sent_at >= ? AND status IN ('sent', 'dry_run')
      LIMIT 1
    `).get(ticker, eventType, sinceIso);
    return Boolean(row);
  }

  saveAlert(input: {
    id: string;
    itemId: string;
    ticker: string;
    eventType: string;
    tier: AlertTier;
    status: "sent" | "dry_run" | "failed" | "suppressed";
    deviceToken?: string | null;
    response?: unknown;
  }): void {
    this.sqlite.prepare(`
      INSERT INTO alerts (
        id, item_id, ticker, event_type, tier, status, device_token, response_json, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.itemId,
      input.ticker,
      input.eventType,
      input.tier,
      input.status,
      input.deviceToken ?? null,
      JSON.stringify(input.response ?? null),
      new Date().toISOString(),
    );
  }

  stats(): Record<string, number> {
    const counts = this.sqlite.prepare(`
      SELECT
        COUNT(*) AS item_count,
        SUM(CASE WHEN status = 'analyzed' THEN 1 ELSE 0 END) AS analyzed_count,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count
      FROM items
    `).get() as { item_count: number; analyzed_count: number; pending_count: number };
    const alertCount = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM alerts WHERE status IN ('sent', 'dry_run')").get() as { count: number }).count;
    const deviceCount = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM devices WHERE active = 1").get() as { count: number }).count;
    const urgentCount = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM analyses WHERE alert_tier = 'urgent'").get() as { count: number }).count;
    return { ...counts, alertCount, deviceCount, urgent_count: urgentCount };
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        external_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_tier TEXT NOT NULL,
        headline TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        author TEXT,
        published_at TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        company_hint TEXT,
        ticker_hint TEXT,
        raw_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS items_source_external_idx ON items(source_id, external_id);
      CREATE INDEX IF NOT EXISTS items_published_idx ON items(published_at DESC);
      CREATE INDEX IF NOT EXISTS items_ticker_idx ON items(ticker_hint, published_at DESC);

      CREATE TABLE IF NOT EXISTS analyses (
        item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        method TEXT NOT NULL,
        assessment_json TEXT NOT NULL,
        policy_score INTEGER NOT NULL,
        alert_tier TEXT NOT NULL,
        policy_reasons_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_state (
        source_id TEXT PRIMARY KEY,
        cursor TEXT,
        last_fetched_at TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS devices (
        installation_id TEXT PRIMARY KEY,
        device_token TEXT NOT NULL UNIQUE,
        environment TEXT NOT NULL,
        time_sensitive_authorized INTEGER NOT NULL DEFAULT 0,
        critical_authorized INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        event_type TEXT NOT NULL,
        tier TEXT NOT NULL,
        status TEXT NOT NULL,
        device_token TEXT,
        response_json TEXT NOT NULL,
        sent_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS alerts_cooldown_idx ON alerts(ticker, event_type, sent_at DESC);
    `);
  }
}

function rowToItem(row: ItemRow): NormalizedItem {
  return {
    id: row.id,
    externalId: row.external_id,
    source: {
      id: row.source_id,
      name: row.source_name,
      type: row.source_type,
      tier: row.source_tier,
    },
    headline: row.headline,
    summary: row.summary,
    url: row.url,
    author: row.author,
    publishedAt: row.published_at,
    discoveredAt: row.discovered_at,
    companyHint: row.company_hint,
    tickerHint: row.ticker_hint,
    raw: JSON.parse(row.raw_json) as unknown,
  };
}

function rowToAnalysis(row: AnalysisRow): AnalysisRecord {
  return {
    itemId: row.item_id,
    model: row.model,
    method: row.method,
    assessment: JSON.parse(row.assessment_json) as ImpactAssessment,
    policyScore: row.policy_score,
    alertTier: row.alert_tier,
    policyReasons: JSON.parse(row.policy_reasons_json) as string[],
    createdAt: row.created_at,
  };
}
