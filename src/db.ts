import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  AccessLevel,
  AlertPriority,
  AlertTier,
  AnalysisRecord,
  CatalystEventType,
  DeviceRegistration,
  FeedEntry,
  FeedMode,
  ImpactAssessment,
  InstallationAccess,
  InstallationPreferences,
  NormalizedItem,
  OutcomeAudit,
  PushMode,
  SourceDescriptor,
  SourceTier,
  SourceType,
  StoreTransactionEntitlement,
  TimelineEvent,
} from "./types.js";
import type { AlertInput, ItemFailureResult, SignalStore } from "./store.js";
import { clinicalSurpriseScore, isSecCalendarMilestoneSentence } from "./timeline.js";
import { normalizedHeadline } from "./utils.js";

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
  provenance: NormalizedItem["provenance"] | null;
  independence_key: string | null;
  status: string;
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: string | null;
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
  event_key: string | null;
  event_anchor_at: string | null;
  analysis_version: number | null;
}

interface OutcomeAuditRow {
  event_key: string;
  item_id: string;
  ticker: string;
  event_type: CatalystEventType;
  alert_tier: AlertTier;
  predicted_direction: ImpactAssessment["stockDirection"];
  probability_positive_move: number;
  expected_move_low_pct: number;
  expected_move_base_pct: number;
  expected_move_high_pct: number;
  initial_materiality: number | null;
  actual_return_pct: number;
  benchmark_return_pct: number | null;
  benchmark_basis: OutcomeAudit["benchmarkBasis"];
  abnormal_return_pct: number | null;
  market_surprise_score: number;
  surprise_adjusted_materiality: number;
  direction_correct: number | null;
  abnormal_direction_correct: number | null;
  expected_range_hit: number;
  movement_window: OutcomeAudit["movementWindow"];
  status: OutcomeAudit["status"];
  price_start_at: string;
  price_end_at: string;
  audited_at: string;
  calibration_version: number;
}

interface TimelineRow {
  id: string;
  status: TimelineEvent["status"];
  basis: TimelineEvent["basis"];
  ticker: string;
  company_name: string;
  program: string;
  normalized_program: string;
  indication: string;
  event_type: CatalystEventType;
  trial_phase: ImpactAssessment["trialPhase"];
  title: string;
  summary: string;
  event_date: string;
  initial_event_date: string;
  date_precision: TimelineEvent["datePrecision"];
  date_label: string;
  source_name: string;
  source_url: string;
  source_tier: SourceTier;
  item_id: string | null;
  event_key: string | null;
  alert_tier: AlertTier | null;
  initial_materiality: number | null;
  anticipated_materiality: number | null;
  confidence: number | null;
  expected_direction: ImpactAssessment["resultDirection"] | null;
  expected_outcome: string | null;
  expected_success_probability: number | null;
  expectation_confidence: number | null;
  expectation_as_of: string | null;
  result_direction: ImpactAssessment["resultDirection"] | null;
  expectation_event_id: string | null;
  resolved_by_event_id: string | null;
  created_at: string;
  updated_at: string;
}

interface InstallationRow {
  installation_id: string;
  client_token_hash: string;
  access_level: AccessLevel;
  product_id: string | null;
  original_transaction_id: string | null;
  transaction_id: string | null;
  expires_at: string | null;
  store_environment: "Sandbox" | "Production" | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PreferenceRow {
  installation_id: string;
  feed_mode: FeedMode;
  push_mode: PushMode;
  minimum_alert_tier: AlertPriority;
  event_types_json: string;
  updated_at: string;
}

const ALL_EVENT_TYPES: CatalystEventType[] = [
  "trial_topline",
  "trial_update",
  "regulatory_decision",
  "regulatory_update",
  "safety_signal",
  "publication",
  "financing",
  "partnership",
  "other",
];
const EVENT_TYPE_SET = new Set<string>(ALL_EVENT_TYPES);

export class SignalDatabase implements SignalStore {
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
    return this.insertItems([item]) === 1;
  }

  insertItems(items: NormalizedItem[]): number {
    if (!items.length) return 0;
    const insert = this.sqlite.prepare(`
      INSERT OR IGNORE INTO items (
        id, external_id, source_id, source_name, source_type, source_tier,
        headline, summary, url, author, published_at, discovered_at,
        company_hint, ticker_hint, provenance, independence_key, raw_json, status
      ) VALUES (
        @id, @externalId, @sourceId, @sourceName, @sourceType, @sourceTier,
        @headline, @summary, @url, @author, @publishedAt, @discoveredAt,
        @companyHint, @tickerHint, @provenance, @independenceKey, @rawJson, 'pending'
      )
    `);
    const updateDescriptor = this.sqlite.prepare(`
      UPDATE items
      SET source_name = ?, source_type = ?, source_tier = ?,
        provenance = COALESCE(?, provenance), independence_key = COALESCE(?, independence_key)
      WHERE id = ? AND (
        source_name <> ? OR source_type <> ? OR source_tier <> ?
        OR (? IS NOT NULL AND provenance IS NULL)
        OR (? IS NOT NULL AND independence_key IS NULL)
        OR (? IS NOT NULL AND provenance IS NOT ?)
        OR (? IS NOT NULL AND independence_key IS NOT ?)
      )
    `);
    const insertMany = this.sqlite.transaction((values: readonly NormalizedItem[]) => {
      let inserted = 0;
      for (const item of values) {
        const result = insert.run({
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
          provenance: item.provenance ?? null,
          independenceKey: item.independenceKey ?? null,
          rawJson: JSON.stringify(item.raw),
        });
        if (result.changes > 0) {
          inserted += 1;
          continue;
        }
        updateDescriptor.run(
          item.source.name,
          item.source.type,
          item.source.tier,
          item.provenance ?? null,
          item.independenceKey ?? null,
          item.id,
          item.source.name,
          item.source.type,
          item.source.tier,
          item.provenance ?? null,
          item.independenceKey ?? null,
          item.provenance ?? null,
          item.provenance ?? null,
          item.independenceKey ?? null,
          item.independenceKey ?? null,
        );
      }
      return inserted;
    });
    return insertMany(items);
  }

  syncSourceDescriptors(sources: readonly SourceDescriptor[]): number {
    const update = this.sqlite.prepare(`
      UPDATE items
      SET source_name = ?, source_type = ?, source_tier = ?
      WHERE source_id = ?
        AND (source_name <> ? OR source_type <> ? OR source_tier <> ?)
    `);
    const sync = this.sqlite.transaction((descriptors: readonly SourceDescriptor[]) => descriptors.reduce(
      (changed, source) => changed + update.run(
        source.name,
        source.type,
        source.tier,
        source.id,
        source.name,
        source.type,
        source.tier,
      ).changes,
      0,
    ));
    return sync(sources);
  }

  saveCompanyPrograms(ticker: string, programs: readonly string[]): number {
    const normalizedTicker = ticker.trim().toUpperCase();
    if (!normalizedTicker) return 0;
    const now = new Date().toISOString();
    const insert = this.sqlite.prepare(`
      INSERT INTO company_programs (ticker, program, normalized_program, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(ticker, normalized_program) DO UPDATE SET
        program = CASE WHEN length(excluded.program) > length(company_programs.program)
          THEN excluded.program ELSE company_programs.program END,
        last_seen_at = excluded.last_seen_at
    `);
    const uniquePrograms = new Map<string, string>();
    for (const raw of programs) {
      const program = raw.trim();
      const normalized = normalizedProgram(program);
      if (program && normalized.length >= 3 && !uniquePrograms.has(normalized)) uniquePrograms.set(normalized, program);
    }
    const values = [...uniquePrograms].slice(0, 250);
    return this.sqlite.transaction((entries: Array<[string, string]>) => entries.reduce(
      (count, [normalized, program]) => count + insert.run(normalizedTicker, program, normalized, now, now).changes,
      0,
    ))(values);
  }

  listCompanyPrograms(): Array<{ ticker: string; program: string }> {
    return this.sqlite.prepare(`
      SELECT ticker, program FROM company_programs ORDER BY ticker, program
    `).all() as Array<{ ticker: string; program: string }>;
  }

  saveAnalysis(record: AnalysisRecord): void {
    const transaction = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO analyses (
          item_id, model, method, assessment_json, policy_score,
          alert_tier, policy_reasons_json, created_at, event_key,
          event_anchor_at, analysis_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          model = excluded.model,
          method = excluded.method,
          assessment_json = excluded.assessment_json,
          policy_score = excluded.policy_score,
          alert_tier = excluded.alert_tier,
          policy_reasons_json = excluded.policy_reasons_json,
          created_at = excluded.created_at,
          event_key = excluded.event_key,
          event_anchor_at = excluded.event_anchor_at,
          analysis_version = excluded.analysis_version
      `).run(
        record.itemId,
        record.model,
        record.method,
        JSON.stringify(record.assessment),
        record.policyScore,
        record.alertTier,
        JSON.stringify(record.policyReasons),
        record.createdAt,
        record.eventKey ?? null,
        record.eventAnchorAt ?? null,
        record.analysisVersion ?? 1,
      );
      if (record.eventKey) {
        this.sqlite.prepare(`
          UPDATE alerts SET event_key = ?
          WHERE item_id = ? AND event_key <> ?
        `).run(record.eventKey, record.itemId, record.eventKey);
      }
      this.sqlite.prepare(`
        UPDATE items SET status = 'analyzed', attempt_count = 0,
          last_error = NULL, next_attempt_at = NULL
        WHERE id = ?
      `).run(record.itemId);
    });
    transaction();
  }

  markItem(itemId: string, status: "skipped" | "error"): void {
    this.sqlite.prepare("UPDATE items SET status = ? WHERE id = ?").run(status, itemId);
  }

  recordItemFailure(itemId: string, error: string, maxAttempts = 4): ItemFailureResult {
    const row = this.sqlite.prepare("SELECT attempt_count FROM items WHERE id = ?").get(itemId) as { attempt_count: number } | undefined;
    const attemptCount = (row?.attempt_count ?? 0) + 1;
    const retryScheduled = attemptCount < maxAttempts;
    const delayMinutes = Math.min(15, 2 ** Math.max(0, attemptCount - 1));
    const nextAttemptAt = retryScheduled
      ? new Date(Date.now() + delayMinutes * 60_000).toISOString()
      : null;
    this.sqlite.prepare(`
      UPDATE items SET status = 'error', attempt_count = ?, last_error = ?, next_attempt_at = ?
      WHERE id = ?
    `).run(attemptCount, error.slice(0, 4_000), nextAttemptAt, itemId);
    return { attemptCount, retryScheduled, nextAttemptAt };
  }

  getItem(itemId: string): NormalizedItem | null {
    const row = this.sqlite.prepare("SELECT * FROM items WHERE id = ?").get(itemId) as ItemRow | undefined;
    return row ? rowToItem(row) : null;
  }

  getPendingItems(limit = 100): NormalizedItem[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM items
      WHERE status = 'pending'
        OR (status = 'error' AND attempt_count < 4 AND next_attempt_at <= ?)
      ORDER BY
        CASE source_type
          WHEN 'regulator' THEN 0
          WHEN 'company_ir' THEN 0
          WHEN 'sec' THEN 0
          WHEN 'outlet' THEN 1
          WHEN 'clinical_trials' THEN 2
          ELSE 3
        END,
        published_at DESC,
        discovered_at ASC
      LIMIT ?
    `).all(new Date().toISOString(), limit) as ItemRow[];
    return rows.map(rowToItem);
  }

  requeueFailedItems(limit = 20): number {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.sqlite.prepare(`
      SELECT id FROM items
      WHERE status = 'error' AND next_attempt_at IS NULL
      ORDER BY published_at DESC, discovered_at DESC, rowid DESC
      LIMIT ?
    `).all(boundedLimit) as Array<{ id: string }>;
    if (!rows.length) return 0;
    const update = this.sqlite.prepare(`
      UPDATE items SET status = 'pending', attempt_count = 0,
        last_error = NULL, next_attempt_at = NULL WHERE id = ?
    `);
    return this.sqlite.transaction((ids: Array<{ id: string }>) => ids.reduce(
      (count, row) => count + update.run(row.id).changes,
      0,
    ))(rows);
  }

  findCorroboratingItems(item: NormalizedItem, sinceIso: string): NormalizedItem[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM items
      WHERE id <> ? AND published_at >= ? AND published_at <= datetime(?, '+72 hours')
        AND (
          (? IS NOT NULL AND ticker_hint = ?)
          OR (? IS NOT NULL AND company_hint = ?)
        )
      ORDER BY published_at DESC LIMIT 20
    `).all(
      item.id,
      sinceIso,
      item.publishedAt,
      item.tickerHint,
      item.tickerHint,
      item.companyHint,
      item.companyHint,
    ) as ItemRow[];
    return rows.map(rowToItem);
  }

  findPriorItems(item: NormalizedItem, sinceIso: string, limit = 12): NormalizedItem[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM items
      WHERE id <> ? AND julianday(published_at) >= julianday(?)
        AND julianday(published_at) < julianday(?, '-30 minutes')
        AND status = 'analyzed'
        AND (
          (? IS NOT NULL AND ticker_hint = ?)
          OR (? IS NOT NULL AND company_hint = ?)
        )
      ORDER BY published_at DESC LIMIT ?
    `).all(
      item.id,
      sinceIso,
      item.publishedAt,
      item.tickerHint,
      item.tickerHint,
      item.companyHint,
      item.companyHint,
      limit,
    ) as ItemRow[];
    return rows.map(rowToItem);
  }

  requeueOutdatedAnalyses(analysisVersion: number, sinceIso: string, limit = 250): number {
    const rows = this.sqlite.prepare(`
      SELECT i.id FROM items i
      INNER JOIN analyses a ON a.item_id = i.id
      WHERE i.published_at >= ? AND COALESCE(a.analysis_version, 1) < ?
        AND i.source_type <> 'clinical_trials'
        AND (
          a.alert_tier <> 'none'
          OR json_extract(a.assessment_json, '$.isBiotechCatalyst') = 1
        )
      ORDER BY i.published_at DESC LIMIT ?
    `).all(sinceIso, analysisVersion, limit) as Array<{ id: string }>;
    if (!rows.length) return 0;
    const update = this.sqlite.prepare(`
      UPDATE items SET status = 'pending', attempt_count = 0,
        last_error = NULL, next_attempt_at = NULL WHERE id = ?
    `);
    return this.sqlite.transaction((ids: Array<{ id: string }>) => ids.reduce(
      (count, row) => count + update.run(row.id).changes,
      0,
    ))(rows);
  }

  listOutcomeAuditCandidates(limit = 30, auditedBefore = new Date(Date.now() - 15 * 60_000).toISOString()): FeedEntry[] {
    const eligibleAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const rows = this.sqlite.prepare(`
      SELECT i.*, a.item_id, a.model, a.method, a.assessment_json, a.policy_score,
        a.alert_tier, a.policy_reasons_json, a.created_at, a.event_key,
        a.event_anchor_at, a.analysis_version
      FROM analyses a
      INNER JOIN items i ON i.id = a.item_id
      LEFT JOIN outcome_audits o ON o.event_key = a.event_key
      WHERE a.event_key IS NOT NULL
        AND a.alert_tier IN ('watch', 'high', 'urgent')
        AND json_extract(a.assessment_json, '$.isBiotechCatalyst') = 1
        AND COALESCE(a.event_anchor_at, i.published_at) <= ?
        AND (
          o.event_key IS NULL
          OR COALESCE(o.calibration_version, 1) < 2
          OR (o.status <> 'closed' AND o.audited_at <= ?)
        )
      ORDER BY
        CASE a.alert_tier WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
        COALESCE(a.event_anchor_at, i.published_at) DESC
      LIMIT ?
    `).all(eligibleAt, auditedBefore, Math.max(limit, limit * 6)) as Array<ItemRow & AnalysisRow>;
    const events = new Map<string, FeedEntry>();
    for (const row of rows) {
      const analysis = rowToAnalysis(row);
      if (!analysis.eventKey) continue;
      const candidate: FeedEntry = { item: rowToItem(row), analysis, corroborationCount: 0, alertedAt: null };
      const existing = events.get(analysis.eventKey);
      if (!existing || isBetterEventRepresentative(candidate, existing)) events.set(analysis.eventKey, candidate);
    }
    return [...events.values()].slice(0, limit);
  }

  saveOutcomeAudit(audit: OutcomeAudit): void {
    this.sqlite.prepare(`
      INSERT INTO outcome_audits (
        event_key, item_id, ticker, event_type, alert_tier, predicted_direction,
        probability_positive_move, expected_move_low_pct, expected_move_base_pct,
        expected_move_high_pct, initial_materiality, actual_return_pct,
        benchmark_return_pct, benchmark_basis, abnormal_return_pct,
        market_surprise_score, surprise_adjusted_materiality, direction_correct,
        abnormal_direction_correct, expected_range_hit, movement_window, status,
        price_start_at, price_end_at, audited_at, calibration_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        item_id = excluded.item_id,
        ticker = excluded.ticker,
        event_type = excluded.event_type,
        alert_tier = excluded.alert_tier,
        predicted_direction = excluded.predicted_direction,
        probability_positive_move = excluded.probability_positive_move,
        expected_move_low_pct = excluded.expected_move_low_pct,
        expected_move_base_pct = excluded.expected_move_base_pct,
        expected_move_high_pct = excluded.expected_move_high_pct,
        initial_materiality = excluded.initial_materiality,
        actual_return_pct = excluded.actual_return_pct,
        benchmark_return_pct = excluded.benchmark_return_pct,
        benchmark_basis = excluded.benchmark_basis,
        abnormal_return_pct = excluded.abnormal_return_pct,
        market_surprise_score = excluded.market_surprise_score,
        surprise_adjusted_materiality = excluded.surprise_adjusted_materiality,
        direction_correct = excluded.direction_correct,
        abnormal_direction_correct = excluded.abnormal_direction_correct,
        expected_range_hit = excluded.expected_range_hit,
        movement_window = excluded.movement_window,
        status = excluded.status,
        price_start_at = excluded.price_start_at,
        price_end_at = excluded.price_end_at,
        audited_at = excluded.audited_at,
        calibration_version = excluded.calibration_version
    `).run(
      audit.eventKey,
      audit.itemId,
      audit.ticker,
      audit.eventType,
      audit.alertTier,
      audit.predictedDirection,
      audit.probabilityPositiveMove,
      audit.expectedMoveLowPct,
      audit.expectedMoveBasePct,
      audit.expectedMoveHighPct,
      audit.initialMateriality,
      audit.actualReturnPct,
      audit.benchmarkReturnPct,
      audit.benchmarkBasis,
      audit.abnormalReturnPct,
      audit.marketSurpriseScore,
      audit.surpriseAdjustedMateriality,
      audit.directionCorrect === null ? null : audit.directionCorrect ? 1 : 0,
      audit.abnormalDirectionCorrect === null ? null : audit.abnormalDirectionCorrect ? 1 : 0,
      audit.expectedRangeHit ? 1 : 0,
      audit.movementWindow,
      audit.status,
      audit.priceStartAt,
      audit.priceEndAt,
      audit.auditedAt,
      audit.calibrationVersion,
    );
  }

  listOutcomeAudits(limit = 250): OutcomeAudit[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM outcome_audits ORDER BY audited_at DESC LIMIT ?
    `).all(limit) as OutcomeAuditRow[];
    return rows.map(rowToOutcomeAudit);
  }

  upsertTimelineEvents(events: readonly TimelineEvent[]): number {
    if (!events.length) return 0;
    const insert = this.sqlite.prepare(`
      INSERT INTO timeline_events (
        id, status, basis, ticker, company_name, program, normalized_program,
        indication, event_type, trial_phase, title, summary, event_date,
        initial_event_date, date_precision, date_label, source_name, source_url,
        source_tier, item_id, event_key, alert_tier, initial_materiality,
        anticipated_materiality, confidence, expected_direction, expected_outcome,
        expected_success_probability, expectation_confidence, expectation_as_of,
        result_direction, expectation_event_id, resolved_by_event_id, created_at, updated_at
      ) VALUES (
        @id, @status, @basis, @ticker, @companyName, @program, @normalizedProgram,
        @indication, @eventType, @trialPhase, @title, @summary, @eventDate,
        @initialEventDate, @datePrecision, @dateLabel, @sourceName, @sourceUrl,
        @sourceTier, @itemId, @eventKey, @alertTier, @initialMateriality,
        @anticipatedMateriality, @confidence, @expectedDirection, @expectedOutcome,
        @expectedSuccessProbability, @expectationConfidence, @expectationAsOf,
        @resultDirection, @expectationEventId, @resolvedByEventId, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        basis = excluded.basis,
        company_name = excluded.company_name,
        program = excluded.program,
        normalized_program = excluded.normalized_program,
        indication = excluded.indication,
        event_type = excluded.event_type,
        trial_phase = excluded.trial_phase,
        title = excluded.title,
        summary = excluded.summary,
        event_date = excluded.event_date,
        date_precision = excluded.date_precision,
        date_label = excluded.date_label,
        source_name = excluded.source_name,
        source_url = excluded.source_url,
        source_tier = excluded.source_tier,
        item_id = COALESCE(excluded.item_id, timeline_events.item_id),
        event_key = COALESCE(excluded.event_key, timeline_events.event_key),
        alert_tier = COALESCE(timeline_events.alert_tier, excluded.alert_tier),
        initial_materiality = COALESCE(timeline_events.initial_materiality, excluded.initial_materiality),
        anticipated_materiality = timeline_events.anticipated_materiality,
        confidence = COALESCE(timeline_events.confidence, excluded.confidence),
        expected_direction = timeline_events.expected_direction,
        expected_outcome = timeline_events.expected_outcome,
        expected_success_probability = timeline_events.expected_success_probability,
        expectation_confidence = timeline_events.expectation_confidence,
        expectation_as_of = timeline_events.expectation_as_of,
        result_direction = COALESCE(excluded.result_direction, timeline_events.result_direction),
        updated_at = excluded.updated_at
    `);
    return this.sqlite.transaction((values: readonly TimelineEvent[]) => {
      let changed = 0;
      const itemIds = [...new Set(values.map((event) => event.itemId).filter((value): value is string => Boolean(value)))];
      for (const itemId of itemIds) {
        const upcomingIds = values
          .filter((event) => event.itemId === itemId && event.status === "upcoming")
          .map((event) => event.id);
        const keepClause = upcomingIds.length
          ? `AND id NOT IN (${upcomingIds.map(() => "?").join(", ")})`
          : "";
        changed += this.sqlite.prepare(`
          DELETE FROM timeline_events
          WHERE item_id = ? AND status = 'upcoming' AND resolved_by_event_id IS NULL
          ${keepClause}
        `).run(itemId, ...upcomingIds).changes;
      }
      for (const event of values) {
        changed += insert.run({ ...event, normalizedProgram: normalizedProgram(event.program) }).changes;
      }
      for (const event of values) {
        if (event.status === "completed") this.linkTimelineExpectation(event.id);
      }
      return changed;
    })(events);
  }

  listTimelineEvents(
    limit = 500,
    status: TimelineEvent["status"] | null = null,
    publishedBefore: string | null = null,
    tickers: readonly string[] | null = null,
  ): TimelineEvent[] {
    const normalizedTickers = tickers === null
      ? null
      : [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
    if (normalizedTickers?.length === 0) return [];
    const clauses = [
      "resolved_by_event_id IS NULL",
      `(
        (
          status = 'upcoming'
          AND julianday(event_date) >= julianday('now', '-90 days')
        )
        OR (
          status = 'completed'
          AND (alert_tier IN ('high', 'urgent') OR COALESCE(initial_materiality, 0) >= 65)
        )
      )`,
    ];
    const params: Array<string | number> = [];
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (publishedBefore) {
      clauses.push(`(
        (status = 'completed' AND event_date <= ?)
        OR (status = 'upcoming' AND COALESCE(expectation_as_of, created_at) <= ?)
      )`);
      params.push(publishedBefore, publishedBefore);
    }
    if (normalizedTickers) {
      clauses.push(`ticker IN (${normalizedTickers.map(() => "?").join(", ")})`);
      params.push(...normalizedTickers);
    }
    const normalizedLimit = Math.min(Math.max(limit, 1), 1_000);
    params.push(Math.min(normalizedLimit * 3, 3_000));
    const queriedRows = this.sqlite.prepare(`
      SELECT * FROM timeline_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY
        CASE
          WHEN status = 'upcoming' AND date(event_date) >= date('now', '-1 day') THEN 0
          WHEN status = 'upcoming' THEN 1
          ELSE 2
        END,
        CASE WHEN status = 'upcoming' AND date(event_date) >= date('now', '-1 day') THEN event_date END ASC,
        CASE WHEN status = 'upcoming' AND date(event_date) < date('now', '-1 day') THEN event_date END DESC,
        CASE WHEN status = 'completed' THEN event_date END DESC
      LIMIT ?
    `).all(...params) as TimelineRow[];
    const rows = collapseTimelineRows(queriedRows).slice(0, normalizedLimit);
    if (!rows.length) return [];

    const outcomeKeys = [...new Set(rows.map((row) => row.event_key).filter((value): value is string => Boolean(value)))];
    const outcomes = new Map<string, OutcomeAudit>();
    if (outcomeKeys.length) {
      const outcomeRows = this.sqlite.prepare(`
        SELECT * FROM outcome_audits WHERE event_key IN (${outcomeKeys.map(() => "?").join(", ")})
      `).all(...outcomeKeys) as OutcomeAuditRow[];
      for (const row of outcomeRows) outcomes.set(row.event_key, rowToOutcomeAudit(row));
    }
    const expectationIds = [...new Set(rows.map((row) => row.expectation_event_id).filter((value): value is string => Boolean(value)))];
    const expectations = new Map<string, TimelineRow>();
    if (expectationIds.length) {
      const expectationRows = this.sqlite.prepare(`
        SELECT * FROM timeline_events WHERE id IN (${expectationIds.map(() => "?").join(", ")})
      `).all(...expectationIds) as TimelineRow[];
      for (const row of expectationRows) expectations.set(row.id, row);
    }
    return rows.map((row) => rowToTimelineEvent(
      row,
      row.event_key ? outcomes.get(row.event_key) ?? null : null,
      row.expectation_event_id ? expectations.get(row.expectation_event_id) ?? null : null,
    ));
  }

  private linkTimelineExpectation(completedId: string): void {
    const completed = this.sqlite.prepare("SELECT * FROM timeline_events WHERE id = ?")
      .get(completedId) as TimelineRow | undefined;
    if (!completed || completed.status !== "completed" || completed.expectation_event_id
      || !completed.result_direction || completed.result_direction === "unclear") return;
    const candidates = this.sqlite.prepare(`
      SELECT * FROM timeline_events
      WHERE status = 'upcoming' AND resolved_by_event_id IS NULL
        AND ticker = ? AND julianday(expectation_as_of) <= julianday(?, '-1 day')
        AND julianday(event_date) >= julianday(?, '-365 days')
        AND julianday(event_date) <= julianday(?, '+365 days')
      ORDER BY ABS(julianday(event_date) - julianday(?)) ASC
      LIMIT 30
    `).all(
      completed.ticker,
      completed.event_date,
      completed.event_date,
      completed.event_date,
      completed.event_date,
    ) as TimelineRow[];
    const ranked = candidates.map((candidate) => ({
      candidate,
      score: expectationMatchScore(completed, candidate),
    })).sort((left, right) => right.score - left.score);
    const best = ranked[0];
    if (!best || best.score < 7) return;
    this.sqlite.prepare("UPDATE timeline_events SET expectation_event_id = ? WHERE id = ?")
      .run(best.candidate.id, completed.id);
    this.sqlite.prepare("UPDATE timeline_events SET resolved_by_event_id = ?, updated_at = ? WHERE id = ?")
      .run(completed.id, completed.updated_at, best.candidate.id);
  }

  listFeed(limit = 100, publishedBefore: string | null = null, tickers: readonly string[] | null = null): FeedEntry[] {
    const normalizedTickers = tickers === null
      ? null
      : [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
    if (normalizedTickers?.length === 0) return [];
    const tickerPlaceholders = normalizedTickers?.map(() => "?").join(", ") ?? "";
    const tickerClause = normalizedTickers
      ? `AND (
        (a.item_id IS NULL AND UPPER(COALESCE(i.ticker_hint, '')) IN (${tickerPlaceholders}))
        OR (
          json_extract(a.assessment_json, '$.isBiotechCatalyst') = 1
          AND UPPER(COALESCE(NULLIF(json_extract(a.assessment_json, '$.ticker'), ''), i.ticker_hint, ''))
            IN (${tickerPlaceholders})
        )
      )`
      : "";
    const rows = this.sqlite.prepare(`
      SELECT
        i.*,
        a.item_id, a.model, a.method, a.assessment_json, a.policy_score,
        a.alert_tier, a.policy_reasons_json, a.created_at, a.event_key,
        a.event_anchor_at, a.analysis_version,
        CASE WHEN a.event_key IS NOT NULL THEN
          (SELECT COUNT(*) FROM analyses ca WHERE ca.event_key = a.event_key AND ca.item_id <> i.id)
        ELSE
          (SELECT COUNT(*) FROM items c
            WHERE c.id <> i.id AND c.published_at >= datetime(i.published_at, '-24 hours')
              AND ((i.ticker_hint IS NOT NULL AND c.ticker_hint = i.ticker_hint)
                OR (i.company_hint IS NOT NULL AND c.company_hint = i.company_hint)))
        END AS corroboration_count,
        (SELECT MAX(sent_at) FROM alerts al WHERE al.item_id = i.id AND al.status IN ('sent', 'dry_run')) AS alerted_at
      FROM items i
      LEFT JOIN analyses a ON a.item_id = i.id
      WHERE i.status <> 'skipped'
        AND (? IS NULL OR i.published_at <= ?)
        ${tickerClause}
      ORDER BY
        CASE
          WHEN a.alert_tier = 'urgent' AND julianday(i.published_at) >= julianday('now', '-7 days') THEN 0
          ELSE 1
        END,
        i.published_at DESC,
        i.discovered_at DESC
      LIMIT ?
    `).all(
      publishedBefore,
      publishedBefore,
      ...(normalizedTickers ?? []),
      ...(normalizedTickers ?? []),
      Math.min(limit * 8, 2_000),
    ) as Array<ItemRow & Partial<AnalysisRow> & { corroboration_count: number; alerted_at: string | null }>;

    const entries = rows.map((row) => ({
      item: rowToItem(row),
      analysis: row.assessment_json ? rowToAnalysis(row as ItemRow & AnalysisRow) : null,
      corroborationCount: row.corroboration_count,
      alertedAt: row.alerted_at,
    }));
    const grouped = new Map<string, FeedEntry>();
    for (const entry of entries) {
      const key = entry.analysis?.eventKey || normalizedHeadline(entry.item.headline);
      if (!key) continue;
      const existing = grouped.get(key);
      if (!existing || isBetterEventRepresentative(entry, existing)) grouped.set(key, entry);
    }
    return [...grouped.values()].sort(compareFeedEntries).slice(0, limit);
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

  registerInstallation(installationId: string, clientTokenHash: string): boolean {
    const existing = this.sqlite.prepare("SELECT client_token_hash FROM installations WHERE installation_id = ?")
      .get(installationId) as { client_token_hash: string } | undefined;
    if (existing) return existing.client_token_hash === clientTokenHash;
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO installations (
        installation_id, client_token_hash, access_level, created_at, updated_at
      ) VALUES (?, ?, 'free', ?, ?)
    `).run(installationId, clientTokenHash, now, now);
    return true;
  }

  installationTokenMatches(installationId: string, clientTokenHash: string): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 FROM installations WHERE installation_id = ? AND client_token_hash = ?
    `).get(installationId, clientTokenHash);
    return Boolean(row);
  }

  getInstallationAccess(installationId: string): InstallationAccess | null {
    const row = this.sqlite.prepare("SELECT * FROM installations WHERE installation_id = ?")
      .get(installationId) as InstallationRow | undefined;
    if (!row) return null;
    const subscriptionActive = row.access_level === "pro"
      && Boolean(row.expires_at && Date.parse(row.expires_at) > Date.now());
    const developer = row.access_level === "developer";
    return {
      installationId: row.installation_id,
      level: developer ? "developer" : subscriptionActive ? "pro" : "free",
      pro: developer || subscriptionActive,
      productId: developer || subscriptionActive ? row.product_id : null,
      expiresAt: developer || subscriptionActive ? row.expires_at : null,
      source: developer ? "developer" : subscriptionActive ? "app_store" : "free",
    };
  }

  activateDeveloperAccess(installationId: string): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      UPDATE installations
      SET access_level = 'developer', product_id = NULL, expires_at = NULL,
        verified_at = ?, updated_at = ?
      WHERE installation_id = ?
    `).run(now, now, installationId);
  }

  applyStoreTransaction(entitlement: StoreTransactionEntitlement): number {
    const now = new Date().toISOString();
    const active = !entitlement.revoked && Date.parse(entitlement.expiresAt) > Date.now();
    const params = {
      level: active ? "pro" : "free",
      productId: entitlement.productId,
      originalTransactionId: entitlement.originalTransactionId,
      transactionId: entitlement.transactionId,
      expiresAt: entitlement.expiresAt,
      environment: entitlement.environment,
      now,
    };
    let changes = 0;
    if (entitlement.installationId) {
      changes += this.sqlite.prepare(`
        UPDATE installations SET
          access_level = CASE WHEN access_level = 'developer' THEN 'developer' ELSE @level END,
          product_id = @productId,
          original_transaction_id = @originalTransactionId,
          transaction_id = @transactionId,
          expires_at = @expiresAt,
          store_environment = @environment,
          verified_at = @now,
          updated_at = @now
        WHERE installation_id = @installationId
      `).run({ ...params, installationId: entitlement.installationId }).changes;
    }
    changes += this.sqlite.prepare(`
      UPDATE installations SET
        access_level = CASE WHEN access_level = 'developer' THEN 'developer' ELSE @level END,
        product_id = @productId,
        transaction_id = @transactionId,
        expires_at = @expiresAt,
        store_environment = @environment,
        verified_at = @now,
        updated_at = @now
      WHERE original_transaction_id = @originalTransactionId
        AND (@installationId IS NULL OR installation_id <> @installationId)
    `).run({ ...params, installationId: entitlement.installationId ?? null }).changes;
    return changes;
  }

  getInstallationPreferences(installationId: string): InstallationPreferences {
    const row = this.sqlite.prepare("SELECT * FROM installation_preferences WHERE installation_id = ?")
      .get(installationId) as PreferenceRow | undefined;
    const watchedTickers = (this.sqlite.prepare(`
      SELECT ticker FROM installation_watchlist
      WHERE installation_id = ? ORDER BY position, ticker
    `).all(installationId) as Array<{ ticker: string }>).map(({ ticker }) => ticker);
    return {
      installationId,
      watchedTickers,
      feedMode: row?.feed_mode ?? "all",
      pushMode: row?.push_mode ?? "all",
      minimumAlertTier: row?.minimum_alert_tier
        ?? (this.getInstallationAccess(installationId)?.level === "developer" ? "high" : "urgent"),
      eventTypes: parseEventTypes(row?.event_types_json),
      updatedAt: row?.updated_at ?? null,
    };
  }

  updateInstallationPreferences(input: {
    installationId: string;
    watchedTickers: string[];
    feedMode: FeedMode;
    pushMode: PushMode;
    minimumAlertTier?: AlertPriority;
    eventTypes: CatalystEventType[];
  }): InstallationPreferences {
    const watchedTickers = [...new Set(input.watchedTickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
    const eventTypes = [...new Set(input.eventTypes)].filter((eventType) => EVENT_TYPE_SET.has(eventType));
    const now = new Date().toISOString();
    const minimumAlertTier = input.minimumAlertTier
      ?? this.getInstallationPreferences(input.installationId).minimumAlertTier;
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO installation_preferences (
          installation_id, feed_mode, push_mode, minimum_alert_tier, event_types_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          feed_mode = excluded.feed_mode,
          push_mode = excluded.push_mode,
          minimum_alert_tier = excluded.minimum_alert_tier,
          event_types_json = excluded.event_types_json,
          updated_at = excluded.updated_at
      `).run(input.installationId, input.feedMode, input.pushMode, minimumAlertTier, JSON.stringify(eventTypes), now);
      this.sqlite.prepare("DELETE FROM installation_watchlist WHERE installation_id = ?").run(input.installationId);
      const insertTicker = this.sqlite.prepare(`
        INSERT INTO installation_watchlist (installation_id, ticker, position, created_at)
        VALUES (?, ?, ?, ?)
      `);
      watchedTickers.forEach((ticker, position) => insertTicker.run(input.installationId, ticker, position, now));
    })();
    return this.getInstallationPreferences(input.installationId);
  }

  upsertDevice(device: DeviceRegistration): void {
    const deviceToken = device.deviceToken.toLowerCase();
    this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM devices WHERE device_token = ? AND installation_id <> ?")
        .run(deviceToken, device.installationId);
      this.sqlite.prepare(`
        INSERT INTO devices (
          installation_id, device_token, environment, time_sensitive_authorized,
          critical_authorized, attention_sounds_supported, active, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          device_token = excluded.device_token,
          environment = excluded.environment,
          time_sensitive_authorized = excluded.time_sensitive_authorized,
          critical_authorized = excluded.critical_authorized,
          attention_sounds_supported = excluded.attention_sounds_supported,
          active = 1,
          updated_at = excluded.updated_at
      `).run(
        device.installationId,
        deviceToken,
        device.environment,
        device.timeSensitiveAuthorized ? 1 : 0,
        device.criticalAuthorized ? 1 : 0,
        device.attentionSoundsSupported ? 1 : 0,
        new Date().toISOString(),
      );
    })();
  }

  listDevices(): Array<DeviceRegistration & { active: boolean }> {
    const rows = this.sqlite.prepare("SELECT * FROM devices WHERE active = 1 ORDER BY updated_at DESC").all() as Array<{
      installation_id: string;
      device_token: string;
      environment: "sandbox" | "production";
      time_sensitive_authorized: number;
      critical_authorized: number;
      attention_sounds_supported: number;
      active: number;
    }>;
    return rows.map((row) => ({
      installationId: row.installation_id,
      deviceToken: row.device_token,
      environment: row.environment,
      timeSensitiveAuthorized: Boolean(row.time_sensitive_authorized),
      criticalAuthorized: Boolean(row.critical_authorized),
      attentionSoundsSupported: Boolean(row.attention_sounds_supported),
      active: Boolean(row.active),
    }));
  }

  listAlertDevices(ticker?: string, eventType?: CatalystEventType, tier: AlertTier = "urgent"): Array<DeviceRegistration & { active: boolean }> {
    const rows = this.sqlite.prepare(`
      SELECT d.*, COALESCE(p.push_mode, 'all') AS push_mode,
        COALESCE(p.event_types_json, ?) AS event_types_json,
        COALESCE(p.minimum_alert_tier,
          CASE WHEN i.access_level = 'developer' THEN 'high' ELSE 'urgent' END
        ) AS minimum_alert_tier,
        CASE WHEN EXISTS (
          SELECT 1 FROM installation_watchlist w
          WHERE w.installation_id = d.installation_id AND w.ticker = ?
        ) THEN 1 ELSE 0 END AS watches_ticker
      FROM devices d
      INNER JOIN installations i ON i.installation_id = d.installation_id
      LEFT JOIN installation_preferences p ON p.installation_id = d.installation_id
      WHERE d.active = 1
        AND (i.access_level = 'developer' OR (i.access_level = 'pro' AND i.expires_at > ?))
      ORDER BY d.updated_at DESC
    `).all(JSON.stringify(ALL_EVENT_TYPES), ticker?.toUpperCase() ?? "", new Date().toISOString()) as Array<{
      installation_id: string;
      device_token: string;
      environment: "sandbox" | "production";
      time_sensitive_authorized: number;
      critical_authorized: number;
      attention_sounds_supported: number;
      active: number;
      push_mode: PushMode;
      event_types_json: string;
      minimum_alert_tier: AlertPriority;
      watches_ticker: number;
    }>;
    return rows.filter((row) => {
      if (row.push_mode === "watchlist" && !row.watches_ticker) return false;
      if (tier === "high" && row.minimum_alert_tier !== "high") return false;
      return !eventType || parseEventTypes(row.event_types_json).includes(eventType);
    }).map((row) => ({
      installationId: row.installation_id,
      deviceToken: row.device_token,
      environment: row.environment,
      timeSensitiveAuthorized: Boolean(row.time_sensitive_authorized),
      criticalAuthorized: Boolean(row.critical_authorized),
      attentionSoundsSupported: Boolean(row.attention_sounds_supported),
      active: Boolean(row.active),
    }));
  }

  deactivateDevice(deviceToken: string): void {
    this.sqlite.prepare("UPDATE devices SET active = 0, updated_at = ? WHERE device_token = ?").run(new Date().toISOString(), deviceToken.toLowerCase());
  }

  hasRecentAlert(eventKey: string, tier: AlertTier, sinceIso: string): boolean {
    const tiers = tier === "urgent" ? ["urgent"] : ["high", "urgent"];
    const placeholders = tiers.map(() => "?").join(", ");
    const row = this.sqlite.prepare(`
      SELECT 1 FROM alerts
      WHERE event_key = ? AND tier IN (${placeholders}) AND sent_at >= ?
        AND status IN ('sent', 'dry_run')
      LIMIT 1
    `).get(eventKey, ...tiers, sinceIso);
    return Boolean(row);
  }

  tryClaimAlertEvent(input: AlertInput, sinceIso: string): boolean {
    const tiers = input.tier === "urgent" ? ["urgent"] : ["high", "urgent"];
    const placeholders = tiers.map(() => "?").join(", ");
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare(`
        SELECT 1 FROM alerts
        WHERE event_key = ? AND tier IN (${placeholders}) AND sent_at >= ?
          AND (
            status IN ('sent', 'dry_run')
            OR (status = 'claimed' AND sent_at >= ?)
          )
        LIMIT 1
      `).get(
        input.eventKey,
        ...tiers,
        sinceIso,
        new Date(Date.now() - 5 * 60_000).toISOString(),
      );
      if (existing) return false;
      this.insertAlert(input);
      return true;
    })();
  }

  saveAlert(input: AlertInput): void {
    this.insertAlert(input);
  }

  private insertAlert(input: AlertInput): void {
    this.sqlite.prepare(`
      INSERT INTO alerts (
        id, item_id, ticker, event_type, tier, event_key, status, device_token, response_json, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        item_id = excluded.item_id,
        ticker = excluded.ticker,
        event_type = excluded.event_type,
        tier = excluded.tier,
        event_key = excluded.event_key,
        status = excluded.status,
        device_token = excluded.device_token,
        response_json = excluded.response_json,
        sent_at = excluded.sent_at
    `).run(
      input.id,
      input.itemId,
      input.ticker,
      input.eventType,
      input.tier,
      input.eventKey,
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
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'error' AND next_attempt_at IS NOT NULL THEN 1 ELSE 0 END) AS retry_count,
        SUM(CASE WHEN status = 'error' AND next_attempt_at IS NULL THEN 1 ELSE 0 END) AS error_count
      FROM items
    `).get() as { item_count: number; analyzed_count: number; pending_count: number; retry_count: number; error_count: number };
    const alertCount = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM alerts WHERE status IN ('sent', 'dry_run')").get() as { count: number }).count;
    const deviceCount = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM devices WHERE active = 1").get() as { count: number }).count;
    const highCount = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM analyses WHERE alert_tier = 'high'").get() as { count: number }).count;
    const urgentCount = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM analyses WHERE alert_tier = 'urgent'").get() as { count: number }).count;
    const personalizedCount = (this.sqlite.prepare("SELECT COUNT(DISTINCT installation_id) AS count FROM installation_watchlist").get() as { count: number }).count;
    const outcomeCount = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM outcome_audits").get() as { count: number }).count;
    const finalOutcomeCount = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM outcome_audits WHERE status = 'closed'").get() as { count: number }).count;
    const timelineCount = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM timeline_events WHERE resolved_by_event_id IS NULL").get() as { count: number }).count;
    const upcomingTimelineCount = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM timeline_events WHERE status = 'upcoming' AND resolved_by_event_id IS NULL").get() as { count: number }).count;
    return {
      ...counts,
      alertCount,
      deviceCount,
      high_count: highCount,
      urgent_count: urgentCount,
      personalized_count: personalizedCount,
      outcome_count: outcomeCount,
      final_outcome_count: finalOutcomeCount,
      timeline_count: timelineCount,
      upcoming_timeline_count: upcomingTimelineCount,
    };
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
        provenance TEXT,
        independence_key TEXT,
        raw_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS items_source_external_idx ON items(source_id, external_id);
      CREATE INDEX IF NOT EXISTS items_source_id_idx ON items(source_id);
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
        created_at TEXT NOT NULL,
        event_key TEXT,
        event_anchor_at TEXT,
        analysis_version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS source_state (
        source_id TEXT PRIMARY KEY,
        cursor TEXT,
        last_fetched_at TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS company_programs (
        ticker TEXT NOT NULL,
        program TEXT NOT NULL,
        normalized_program TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (ticker, normalized_program)
      );

      CREATE TABLE IF NOT EXISTS devices (
        installation_id TEXT PRIMARY KEY,
        device_token TEXT NOT NULL UNIQUE,
        environment TEXT NOT NULL,
        time_sensitive_authorized INTEGER NOT NULL DEFAULT 0,
        critical_authorized INTEGER NOT NULL DEFAULT 0,
        attention_sounds_supported INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS installations (
        installation_id TEXT PRIMARY KEY,
        client_token_hash TEXT NOT NULL,
        access_level TEXT NOT NULL DEFAULT 'free',
        product_id TEXT,
        original_transaction_id TEXT,
        transaction_id TEXT,
        expires_at TEXT,
        store_environment TEXT,
        verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS installations_original_transaction_idx
        ON installations(original_transaction_id);

      CREATE TABLE IF NOT EXISTS installation_preferences (
        installation_id TEXT PRIMARY KEY REFERENCES installations(installation_id) ON DELETE CASCADE,
        feed_mode TEXT NOT NULL DEFAULT 'all',
        push_mode TEXT NOT NULL DEFAULT 'all',
        minimum_alert_tier TEXT NOT NULL DEFAULT 'urgent',
        event_types_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS installation_watchlist (
        installation_id TEXT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (installation_id, ticker)
      );
      CREATE INDEX IF NOT EXISTS installation_watchlist_ticker_idx
        ON installation_watchlist(ticker, installation_id);

      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        event_type TEXT NOT NULL,
        tier TEXT NOT NULL,
        event_key TEXT,
        status TEXT NOT NULL,
        device_token TEXT,
        response_json TEXT NOT NULL,
        sent_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS alerts_cooldown_idx ON alerts(ticker, event_type, sent_at DESC);

      CREATE TABLE IF NOT EXISTS outcome_audits (
        event_key TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        event_type TEXT NOT NULL,
        alert_tier TEXT NOT NULL,
        predicted_direction TEXT NOT NULL,
        probability_positive_move REAL NOT NULL,
        expected_move_low_pct REAL NOT NULL,
        expected_move_base_pct REAL NOT NULL,
        expected_move_high_pct REAL NOT NULL,
        actual_return_pct REAL NOT NULL,
        direction_correct INTEGER,
        expected_range_hit INTEGER NOT NULL,
        movement_window TEXT NOT NULL,
        status TEXT NOT NULL,
        price_start_at TEXT NOT NULL,
        price_end_at TEXT NOT NULL,
        audited_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outcome_audits_status_idx ON outcome_audits(status, audited_at);

      CREATE TABLE IF NOT EXISTS timeline_events (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        basis TEXT NOT NULL,
        ticker TEXT NOT NULL,
        company_name TEXT NOT NULL,
        program TEXT NOT NULL DEFAULT '',
        normalized_program TEXT NOT NULL DEFAULT '',
        indication TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL,
        trial_phase TEXT NOT NULL DEFAULT 'unknown',
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        event_date TEXT NOT NULL,
        initial_event_date TEXT NOT NULL,
        date_precision TEXT NOT NULL,
        date_label TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_tier TEXT NOT NULL,
        item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
        event_key TEXT,
        alert_tier TEXT,
        initial_materiality INTEGER,
        anticipated_materiality INTEGER,
        confidence REAL,
        expected_direction TEXT,
        expected_outcome TEXT,
        expected_success_probability REAL,
        expectation_confidence REAL,
        expectation_as_of TEXT,
        result_direction TEXT,
        expectation_event_id TEXT REFERENCES timeline_events(id) ON DELETE SET NULL,
        resolved_by_event_id TEXT REFERENCES timeline_events(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS timeline_events_date_idx ON timeline_events(status, event_date);
      CREATE INDEX IF NOT EXISTS timeline_events_ticker_idx ON timeline_events(ticker, event_date);
      CREATE INDEX IF NOT EXISTS timeline_events_event_idx ON timeline_events(event_key);
    `);
    this.ensureColumn("items", "provenance", "TEXT");
    this.ensureColumn("items", "independence_key", "TEXT");
    const addedAttemptCount = this.ensureColumn("items", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("items", "last_error", "TEXT");
    this.ensureColumn("items", "next_attempt_at", "TEXT");
    this.ensureColumn("analyses", "event_key", "TEXT");
    this.ensureColumn("analyses", "event_anchor_at", "TEXT");
    this.ensureColumn("analyses", "analysis_version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("devices", "attention_sounds_supported", "INTEGER NOT NULL DEFAULT 0");
    const addedMinimumAlertTier = this.ensureColumn("installation_preferences", "minimum_alert_tier", "TEXT NOT NULL DEFAULT 'urgent'");
    this.ensureColumn("alerts", "event_key", "TEXT");
    this.ensureColumn("outcome_audits", "initial_materiality", "INTEGER");
    this.ensureColumn("outcome_audits", "benchmark_return_pct", "REAL");
    this.ensureColumn("outcome_audits", "benchmark_basis", "TEXT NOT NULL DEFAULT 'unavailable'");
    this.ensureColumn("outcome_audits", "abnormal_return_pct", "REAL");
    this.ensureColumn("outcome_audits", "market_surprise_score", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("outcome_audits", "surprise_adjusted_materiality", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("outcome_audits", "abnormal_direction_correct", "INTEGER");
    this.ensureColumn("outcome_audits", "calibration_version", "INTEGER NOT NULL DEFAULT 1");
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS analyses_event_idx ON analyses(event_key, alert_tier);
      CREATE INDEX IF NOT EXISTS alerts_event_idx ON alerts(event_key, sent_at DESC);
      DELETE FROM timeline_events
      WHERE item_id IN (SELECT id FROM items WHERE source_id = 'sec-calendar-backfill-v1');
      DELETE FROM items WHERE source_id = 'sec-calendar-backfill-v1';
      DELETE FROM source_state WHERE source_id = 'sec-calendar-backfill-v1';
      DELETE FROM timeline_events
      WHERE status = 'upcoming' AND basis = 'registry_schedule'
        AND (title LIKE '%: study start' OR title LIKE '%: study completion');
      UPDATE alerts SET event_key = ticker || ':' || event_type || ':' || item_id WHERE event_key IS NULL;
      UPDATE outcome_audits
      SET initial_materiality = COALESCE(
        (SELECT COALESCE(
          json_extract(a.assessment_json, '$.marketMateriality'),
          json_extract(a.assessment_json, '$.materiality')
        ) FROM analyses a WHERE a.item_id = outcome_audits.item_id),
        initial_materiality,
        0
      )
      WHERE initial_materiality IS NULL;
      UPDATE outcome_audits
      SET surprise_adjusted_materiality = initial_materiality
      WHERE calibration_version < 2 AND surprise_adjusted_materiality = 0;
    `);
    const staleSecEvents = this.sqlite.prepare(`
      SELECT id, summary FROM timeline_events
      WHERE status = 'upcoming' AND basis = 'company_guidance'
        AND source_name = 'SEC catalyst calendar'
    `).all() as Array<{ id: string; summary: string }>;
    const deleteTimelineEvent = this.sqlite.prepare("DELETE FROM timeline_events WHERE id = ?");
    this.sqlite.transaction((rows: Array<{ id: string; summary: string }>) => {
      for (const row of rows) {
        if (!isSecCalendarMilestoneSentence(row.summary)) deleteTimelineEvent.run(row.id);
      }
    })(staleSecEvents);
    if (addedAttemptCount) {
      this.sqlite.prepare(`
        UPDATE items SET next_attempt_at = ? WHERE status = 'error' AND attempt_count = 0
      `).run(new Date().toISOString());
    }
    if (addedMinimumAlertTier) {
      this.sqlite.exec(`
        UPDATE installation_preferences SET minimum_alert_tier = 'high'
        WHERE installation_id IN (SELECT installation_id FROM installations WHERE access_level = 'developer')
      `);
    }
  }

  private ensureColumn(table: string, column: string, definition: string): boolean {
    const columns = this.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      return true;
    }
    return false;
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
    ...(row.provenance ? { provenance: row.provenance } : {}),
    ...(row.independence_key ? { independenceKey: row.independence_key } : {}),
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
    ...(row.event_key ? { eventKey: row.event_key } : {}),
    ...(row.event_anchor_at ? { eventAnchorAt: row.event_anchor_at } : {}),
    ...(row.analysis_version ? { analysisVersion: row.analysis_version } : {}),
  };
}

function rowToOutcomeAudit(row: OutcomeAuditRow): OutcomeAudit {
  return {
    eventKey: row.event_key,
    itemId: row.item_id,
    ticker: row.ticker,
    eventType: row.event_type,
    alertTier: row.alert_tier,
    predictedDirection: row.predicted_direction,
    probabilityPositiveMove: row.probability_positive_move,
    expectedMoveLowPct: row.expected_move_low_pct,
    expectedMoveBasePct: row.expected_move_base_pct,
    expectedMoveHighPct: row.expected_move_high_pct,
    initialMateriality: row.initial_materiality ?? 0,
    actualReturnPct: row.actual_return_pct,
    benchmarkReturnPct: row.benchmark_return_pct,
    benchmarkBasis: row.benchmark_basis,
    abnormalReturnPct: row.abnormal_return_pct,
    marketSurpriseScore: row.market_surprise_score,
    surpriseAdjustedMateriality: row.surprise_adjusted_materiality,
    directionCorrect: row.direction_correct === null ? null : Boolean(row.direction_correct),
    abnormalDirectionCorrect: row.abnormal_direction_correct === null ? null : Boolean(row.abnormal_direction_correct),
    expectedRangeHit: Boolean(row.expected_range_hit),
    movementWindow: row.movement_window,
    status: row.status,
    priceStartAt: row.price_start_at,
    priceEndAt: row.price_end_at,
    auditedAt: row.audited_at,
    calibrationVersion: row.calibration_version,
  };
}

function rowToTimelineEvent(
  row: TimelineRow,
  outcome: OutcomeAudit | null,
  expectation: TimelineRow | null,
): TimelineEvent {
  const expected = expectation ?? row;
  return {
    id: row.id,
    status: row.status,
    basis: row.basis,
    ticker: row.ticker,
    companyName: row.company_name,
    program: row.program,
    indication: row.indication,
    eventType: row.event_type,
    trialPhase: row.trial_phase,
    title: row.title,
    summary: row.summary,
    eventDate: row.event_date,
    initialEventDate: row.initial_event_date,
    datePrecision: row.date_precision,
    dateLabel: row.date_label,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    sourceTier: row.source_tier,
    itemId: row.item_id,
    eventKey: row.event_key,
    alertTier: row.alert_tier,
    initialMateriality: row.initial_materiality,
    anticipatedMateriality: expected.anticipated_materiality,
    confidence: row.confidence,
    expectedDirection: expected.expected_direction,
    expectedOutcome: expected.expected_outcome,
    expectedSuccessProbability: expected.expected_success_probability,
    expectationConfidence: expected.expectation_confidence,
    expectationAsOf: expected.expectation_as_of,
    resultDirection: row.result_direction,
    expectationEventId: row.expectation_event_id,
    resolvedByEventId: row.resolved_by_event_id,
    clinicalSurpriseScore: clinicalSurpriseScore(expected.expected_success_probability, row.result_direction),
    outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function expectationMatchScore(completed: TimelineRow, expected: TimelineRow): number {
  const exactType = completed.event_type === expected.event_type;
  const compatibleType = exactType || (
    [completed.event_type, expected.event_type].every((eventType) => ["trial_topline", "publication"].includes(eventType))
    || [completed.event_type, expected.event_type].every((eventType) => ["regulatory_decision", "regulatory_update"].includes(eventType))
  );
  if (!compatibleType) return 0;
  let score = exactType ? 3 : 1;
  const completedProgram = normalizedProgram(completed.program);
  const expectedProgram = normalizedProgram(expected.program);
  if (completedProgram && expectedProgram && completedProgram === expectedProgram) score += 6;
  score += tokenOverlap(completed.title, expected.title) * 4;
  score += tokenOverlap(completed.indication, expected.indication) * 2;
  return score;
}

function collapseTimelineRows(rows: readonly TimelineRow[]): TimelineRow[] {
  const selected = new Map<string, TimelineRow>();
  for (const row of rows) {
    const key = timelineRowKey(row);
    const existing = selected.get(key);
    if (!existing || timelineRepresentativeScore(row) > timelineRepresentativeScore(existing)) {
      selected.set(key, row);
    }
  }
  return [...selected.values()];
}

function timelineRowKey(row: TimelineRow): string {
  if (row.status === "completed") return `completed:${row.id}`;
  const subject = row.normalized_program || normalizedProgram(row.indication);
  if (!subject) return `upcoming:${row.id}`;
  return ["upcoming", row.ticker, row.event_type, subject, row.event_date.slice(0, 10)].join(":");
}

function timelineRepresentativeScore(row: TimelineRow): number {
  let score = row.basis === "registry_schedule" ? 8 : 4;
  if (row.expected_success_probability !== null) score += 10;
  if (row.source_tier === "primary") score += 3;
  if (!/\b(?:forward-looking statements?|safe harbor|risks and uncertainties|may differ materially)\b/i.test(row.title)) score += 6;
  score += Math.max(0, 5 - Math.floor(row.title.length / 55));
  return score;
}

function tokenOverlap(left: string, right: string): number {
  const tokens = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  return [...leftTokens].filter((token) => rightTokens.has(token)).length / Math.min(leftTokens.size, rightTokens.size);
}

function isBetterEventRepresentative(candidate: FeedEntry, existing: FeedEntry): boolean {
  const tierRank: Record<AlertTier, number> = { none: 0, watch: 1, high: 2, urgent: 3 };
  const candidateTier = candidate.analysis?.alertTier ?? "none";
  const existingTier = existing.analysis?.alertTier ?? "none";
  if (tierRank[candidateTier] !== tierRank[existingTier]) return tierRank[candidateTier] > tierRank[existingTier];
  const sourceRank = (entry: FeedEntry) => entry.item.provenance === "direct_primary" ? 3
    : entry.item.provenance === "syndicated_primary" ? 2
      : entry.item.source.tier === "primary" ? 2 : 1;
  if (sourceRank(candidate) !== sourceRank(existing)) return sourceRank(candidate) > sourceRank(existing);
  return Date.parse(candidate.item.publishedAt) < Date.parse(existing.item.publishedAt);
}

function compareFeedEntries(left: FeedEntry, right: FeedEntry): number {
  const leftUrgent = left.analysis?.alertTier === "urgent" && Date.now() - Date.parse(left.item.publishedAt) <= 7 * 24 * 60 * 60_000;
  const rightUrgent = right.analysis?.alertTier === "urgent" && Date.now() - Date.parse(right.item.publishedAt) <= 7 * 24 * 60 * 60_000;
  if (leftUrgent !== rightUrgent) return leftUrgent ? -1 : 1;
  const leftAt = left.analysis?.eventAnchorAt ?? left.item.publishedAt;
  const rightAt = right.analysis?.eventAnchorAt ?? right.item.publishedAt;
  return Date.parse(rightAt) - Date.parse(leftAt);
}

function parseEventTypes(value: string | undefined): CatalystEventType[] {
  if (!value) return [...ALL_EVENT_TYPES];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [...ALL_EVENT_TYPES];
    const valid = parsed.filter((eventType): eventType is CatalystEventType => (
      typeof eventType === "string" && EVENT_TYPE_SET.has(eventType)
    ));
    return valid.length ? valid : [...ALL_EVENT_TYPES];
  } catch {
    return [...ALL_EVENT_TYPES];
  }
}

function normalizedProgram(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 160);
}
