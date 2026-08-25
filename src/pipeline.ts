import { randomUUID } from "node:crypto";
import type { CatalystAnalyzer } from "./analysis/analyzer.js";
import { decideAlert } from "./analysis/policy.js";
import type { AlertDispatchSummary, AlertService } from "./alerts/service.js";
import type { AppConfig } from "./config.js";
import { areLikelySameEvent, eventIdentity } from "./events.js";
import type { OutcomeAuditorLike, OutcomeAuditSummary } from "./outcomes.js";
import type { SignalStore, SourceStateUpdate } from "./store.js";
import type { EvidenceContext, ImpactAssessment, NormalizedItem, SourceAdapter } from "./types.js";
import { isCatalystCandidate, mapWithConcurrency, resolveWatchCompany } from "./utils.js";

export const CURRENT_ANALYSIS_VERSION = 2;

export interface PipelineLogger {
  info(bindings: Record<string, unknown>, message?: string): void;
  warn(bindings: Record<string, unknown>, message?: string): void;
  error(bindings: Record<string, unknown>, message?: string): void;
}

export interface ScanSummary {
  startedAt: string;
  finishedAt: string;
  sourceCount: number;
  fetchedCount: number;
  insertedCount: number;
  analyzedCount: number;
  skippedCount: number;
  errorCount: number;
  highCount: number;
  urgentCount: number;
  outcomeAuditedCount: number;
  alreadyRunning: boolean;
}

export interface PolicyReconciliationSummary {
  checkedCount: number;
  updatedCount: number;
  errorCount: number;
}

interface ProcessingSummary {
  analyzedCount: number;
  skippedCount: number;
  errorCount: number;
  highCount: number;
  urgentCount: number;
}

interface PipelineTelemetry {
  polling: boolean;
  analyzing: boolean;
  queueDepth: number;
  lastPollStartedAt: string | null;
  lastPollFinishedAt: string | null;
  lastPollDurationMs: number | null;
  discoveryLatencySeconds: LatencySnapshot;
  analysisLatencySeconds: LatencySnapshot;
  pushLatencySeconds: LatencySnapshot;
  lastOutcomeAudit: OutcomeAuditSummary | null;
  slo: AppConfig["slo"];
}

interface LatencySnapshot {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  breachCount: number;
}

export class MonitorPipeline {
  private polling = false;
  private analyzing = false;
  private queueDepth = 0;
  private lastPollStartedAt: string | null = null;
  private lastPollFinishedAt: string | null = null;
  private lastPollDurationMs: number | null = null;
  private readonly discoveryLatencies: number[] = [];
  private readonly analysisLatencies: number[] = [];
  private readonly pushLatencies: number[] = [];
  private readonly analysisLatencyEligibleItemIds = new Set<string>();
  private lastOutcomeAudit: OutcomeAuditSummary | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: SignalStore,
    private readonly sources: SourceAdapter[],
    private readonly analyzer: CatalystAnalyzer,
    private readonly alerts: AlertService,
    private readonly logger: PipelineLogger,
    private readonly outcomeAuditor?: OutcomeAuditorLike,
  ) {}

  telemetry(): PipelineTelemetry {
    const slo = this.config.slo ?? { discoverySeconds: 120, analysisSeconds: 45, pushSeconds: 180 };
    return {
      polling: this.polling,
      analyzing: this.analyzing,
      queueDepth: this.queueDepth,
      lastPollStartedAt: this.lastPollStartedAt,
      lastPollFinishedAt: this.lastPollFinishedAt,
      lastPollDurationMs: this.lastPollDurationMs,
      discoveryLatencySeconds: latencySnapshot(this.discoveryLatencies, slo.discoverySeconds),
      analysisLatencySeconds: latencySnapshot(this.analysisLatencies, slo.analysisSeconds),
      pushLatencySeconds: latencySnapshot(this.pushLatencies, slo.pushSeconds),
      lastOutcomeAudit: this.lastOutcomeAudit,
      slo,
    };
  }

  async requeueOutdatedAnalyses(days = 7, limit = 250): Promise<number> {
    if (!this.db.requeueOutdatedAnalyses) return 0;
    const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    const count = await this.db.requeueOutdatedAnalyses(CURRENT_ANALYSIS_VERSION, since, limit);
    if (count) this.logger.info({ count, analysisVersion: CURRENT_ANALYSIS_VERSION }, "outdated analyses queued for v2 review");
    return count;
  }

  async reconcileStoredPolicies(limit = 1_000): Promise<PolicyReconciliationSummary> {
    let checkedCount = 0;
    let updatedCount = 0;
    let errorCount = 0;
    const entries = await this.db.listFeed(limit);
    for (const entry of entries) {
      if (!entry.analysis) continue;
      checkedCount += 1;
      try {
        const context = await this.buildContext(entry.item);
        const decision = decideAlert(entry.analysis.assessment, context, entry.analysis.method, this.config.alertPolicy);
        const identity = eventIdentity(entry.analysis.assessment, context);
        const assessment = withEffectiveMarketMateriality(entry.analysis.assessment, decision.effectiveMarketMateriality);
        const next = {
          ...entry.analysis,
          assessment,
          policyScore: decision.score,
          alertTier: decision.tier,
          policyReasons: decision.reasons,
          eventKey: identity.eventKey,
          eventAnchorAt: identity.eventAnchorAt,
          analysisVersion: entry.analysis.analysisVersion ?? 1,
        };
        if (JSON.stringify(next) === JSON.stringify(entry.analysis)) continue;
        await this.db.saveAnalysis(next);
        updatedCount += 1;
      } catch (error) {
        errorCount += 1;
        this.logger.warn({ itemId: entry.item.id, error: errorMessage(error) }, "stored signal policy reconciliation failed");
      }
    }
    const summary = { checkedCount, updatedCount, errorCount };
    this.logger.info(summary, "stored signal policies reconciled");
    return summary;
  }

  async run(): Promise<ScanSummary> {
    const startedAt = new Date().toISOString();
    const poll = await this.pollSources(startedAt);
    const processed = await this.drainPending();
    this.lastOutcomeAudit = this.outcomeAuditor ? await this.outcomeAuditor.run() : null;
    const finishedAt = new Date().toISOString();
    const summary = {
      startedAt,
      finishedAt,
      sourceCount: this.sources.length,
      fetchedCount: poll.fetchedCount,
      insertedCount: poll.insertedCount,
      analyzedCount: processed.analyzedCount,
      skippedCount: processed.skippedCount,
      errorCount: poll.errorCount + processed.errorCount,
      highCount: processed.highCount,
      urgentCount: processed.urgentCount,
      outcomeAuditedCount: this.lastOutcomeAudit?.recorded ?? 0,
      alreadyRunning: poll.alreadyRunning,
    };
    this.logger.info(summary, "monitor scan completed");
    return summary;
  }

  private async pollSources(startedAt: string): Promise<{
    fetchedCount: number;
    insertedCount: number;
    errorCount: number;
    alreadyRunning: boolean;
  }> {
    if (this.polling) return { fetchedCount: 0, insertedCount: 0, errorCount: 0, alreadyRunning: true };
    this.polling = true;
    this.lastPollStartedAt = startedAt;
    const leaseId = randomUUID();
    let ownsLease = false;
    let fetchedCount = 0;
    let insertedCount = 0;
    let errorCount = 0;
    try {
      if (this.db.tryAcquireScanLease) {
        ownsLease = await this.db.tryAcquireScanLease(leaseId, new Date(Date.now() + 2 * 60_000).toISOString());
        if (!ownsLease) return { fetchedCount, insertedCount, errorCount, alreadyRunning: true };
      }
      const sourceIds = this.sources.map((source) => source.descriptor.id);
      const cursors = this.db.getSourceCursors
        ? await this.db.getSourceCursors(sourceIds)
        : new Map(await Promise.all(sourceIds.map(async (sourceId) => [sourceId, await this.db.getSourceCursor(sourceId)] as const)));
      const sourceStateUpdates: SourceStateUpdate[] = [];
      const fetches = await Promise.allSettled(this.sources.map(async (source) => {
        const cursor = cursors.get(source.descriptor.id) ?? null;
        try {
          const result = await source.fetch(cursor);
          sourceStateUpdates.push({
            sourceId: source.descriptor.id,
            cursor: result.cursor ?? cursor,
            error: null,
            fetchedAt: new Date().toISOString(),
          });
          this.logger.info({ source: source.descriptor.id, count: result.items.length, diagnostics: result.diagnostics }, "source fetched");
          return { items: result.items, latencyEligible: Boolean(cursor) };
        } catch (error) {
          sourceStateUpdates.push({
            sourceId: source.descriptor.id,
            cursor,
            error: errorMessage(error),
            fetchedAt: new Date().toISOString(),
          });
          this.logger.warn({ source: source.descriptor.id, error: errorMessage(error) }, "source fetch failed");
          throw error;
        }
      }));
      if (this.db.saveSourceStates) await this.db.saveSourceStates(sourceStateUpdates);
      else await Promise.all(sourceStateUpdates.map((state) => this.db.saveSourceState(
        state.sourceId, state.cursor, state.error, state.fetchedAt,
      )));
      const items: NormalizedItem[] = [];
      const latencyEligibleItemIds = new Set<string>();
      for (const result of fetches) {
        if (result.status === "rejected") {
          errorCount += 1;
          continue;
        }
        fetchedCount += result.value.items.length;
        items.push(...result.value.items);
        if (result.value.latencyEligible) {
          for (const item of result.value.items) latencyEligibleItemIds.add(item.id);
        }
      }
      const insertedItemIds = new Set<string>();
      if (this.db.insertItems) {
        insertedCount = await this.db.insertItems(items);
        if (insertedCount === items.length) for (const item of items) insertedItemIds.add(item.id);
      } else {
        for (const item of items) {
          if (await this.db.insertItem(item)) {
            insertedCount += 1;
            insertedItemIds.add(item.id);
            if (latencyEligibleItemIds.has(item.id)) this.analysisLatencyEligibleItemIds.add(item.id);
          }
        }
      }
      if (this.db.saveCompanyPrograms) {
        for (const company of this.config.watchlist) {
          if (company.programs.length) await this.db.saveCompanyPrograms(company.ticker, company.programs);
        }
      }
      for (const item of items) {
        if (!insertedItemIds.has(item.id) || !latencyEligibleItemIds.has(item.id)) continue;
        if (item.source.type === "clinical_trials") continue;
        const latency = (Date.parse(item.discoveredAt) - Date.parse(item.publishedAt)) / 1000;
        if (latency >= 0 && latency <= 7 * 24 * 60 * 60) observe(this.discoveryLatencies, latency);
      }
      return { fetchedCount, insertedCount, errorCount, alreadyRunning: false };
    } finally {
      if (ownsLease && this.db.releaseScanLease) {
        await Promise.resolve(this.db.releaseScanLease(leaseId)).catch((error: unknown) => {
          this.logger.warn({ error: errorMessage(error) }, "scan lease release failed");
        });
      }
      this.polling = false;
      this.lastPollFinishedAt = new Date().toISOString();
      this.lastPollDurationMs = Date.parse(this.lastPollFinishedAt) - Date.parse(startedAt);
    }
  }

  private async drainPending(): Promise<ProcessingSummary> {
    if (this.analyzing) return emptyProcessingSummary();
    this.analyzing = true;
    const total = emptyProcessingSummary();
    try {
      for (let cycle = 0; cycle < 20; cycle += 1) {
        const batchSize = this.config.analysis?.batchSize ?? 100;
        const concurrency = this.config.analysis?.concurrency ?? 4;
        const items = await this.db.getPendingItems(batchSize);
        this.queueDepth = items.length;
        if (!items.length) break;
        const settled = await mapWithConcurrency(items, concurrency, (item) => this.processItem(item));
        for (const result of settled) {
          if (result.status === "rejected") {
            total.errorCount += 1;
            this.logger.error({ error: errorMessage(result.reason) }, "queued analysis task failed unexpectedly");
            continue;
          }
          total.analyzedCount += result.value.analyzedCount;
          total.skippedCount += result.value.skippedCount;
          total.errorCount += result.value.errorCount;
          total.highCount += result.value.highCount;
          total.urgentCount += result.value.urgentCount;
        }
        if (items.length < batchSize) break;
      }
      this.queueDepth = (await this.db.getPendingItems(1)).length;
      return total;
    } finally {
      this.analyzing = false;
    }
  }

  private async processItem(item: NormalizedItem): Promise<ProcessingSummary> {
    const combinedText = `${item.headline}\n${item.summary}`;
    const trustedHint = ["company_ir", "sec", "regulator", "clinical_trials"].includes(item.source.type)
      ? item.tickerHint : null;
    if (!isCatalystCandidate(combinedText, this.config.watchlist, {
      tickerHint: trustedHint,
      sourceType: item.source.type,
      headline: item.headline,
      summary: item.summary,
    })) {
      this.analysisLatencyEligibleItemIds.delete(item.id);
      await this.db.markItem(item.id, "skipped");
      return { ...emptyProcessingSummary(), skippedCount: 1 };
    }
    try {
      const isReanalysis = Boolean(await this.db.getAnalysis(item.id));
      const context = await this.buildContext(item);
      const result = await this.analyzer.analyze(context);
      const identity = eventIdentity(result.assessment, context);
      const decision = decideAlert(result.assessment, context, result.method, this.config.alertPolicy);
      const assessment = withEffectiveMarketMateriality(result.assessment, decision.effectiveMarketMateriality);
      const analysis = {
        itemId: item.id,
        model: result.model,
        method: result.method,
        assessment,
        policyScore: decision.score,
        alertTier: decision.tier,
        policyReasons: decision.reasons,
        createdAt: new Date().toISOString(),
        eventKey: identity.eventKey,
        eventAnchorAt: identity.eventAnchorAt,
        analysisVersion: CURRENT_ANALYSIS_VERSION,
      } as const;
      await this.db.saveAnalysis(analysis);
      const analysisLatency = (Date.parse(analysis.createdAt) - Date.parse(item.discoveredAt)) / 1000;
      if (!isReanalysis && this.analysisLatencyEligibleItemIds.delete(item.id) && analysisLatency >= 0) {
        observe(this.analysisLatencies, analysisLatency);
      }
      let dispatch: AlertDispatchSummary | null = null;
      if (["high", "urgent"].includes(decision.tier)) {
        dispatch = await this.alerts.dispatch(item, analysis);
        if (dispatch.sent > 0) {
          const pushLatency = (Date.now() - Date.parse(identity.eventAnchorAt)) / 1000;
          if (pushLatency >= 0) observe(this.pushLatencies, pushLatency);
        }
        this.logger.info({ itemId: item.id, eventKey: identity.eventKey, ticker: result.assessment.ticker, tier: decision.tier, dispatch }, "priority signal processed");
      }
      return {
        analyzedCount: 1,
        skippedCount: 0,
        errorCount: 0,
        highCount: decision.tier === "high" ? 1 : 0,
        urgentCount: decision.tier === "urgent" ? 1 : 0,
      };
    } catch (error) {
      const message = errorMessage(error);
      const failure = this.db.recordItemFailure
        ? await this.db.recordItemFailure(item.id, message)
        : (await this.db.markItem(item.id, "error"), null);
      this.logger.error({ itemId: item.id, error: message, failure }, "analysis failed");
      return { ...emptyProcessingSummary(), errorCount: 1 };
    }
  }

  private async buildContext(item: NormalizedItem): Promise<EvidenceContext> {
    const trustedHint = ["company_ir", "sec", "regulator", "clinical_trials"].includes(item.source.type)
      ? item.tickerHint : null;
    const company = resolveWatchCompany({
      headline: item.headline,
      summary: item.summary,
      tickerHint: trustedHint,
      companyHint: trustedHint ? item.companyHint : null,
    }, this.config.watchlist);
    const relatedSince = new Date(Date.parse(item.publishedAt) - 72 * 60 * 60_000).toISOString();
    const candidates = await this.db.findCorroboratingItems(item, relatedSince);
    const corroboratingItems = candidates.filter((candidate) => areLikelySameEvent(item, candidate, company)).slice(0, 8);
    const historyDays = this.config.analysis?.historyDays ?? 180;
    const historySince = new Date(Date.parse(item.publishedAt) - historyDays * 24 * 60 * 60_000).toISOString();
    const priorItems = (await this.db.findPriorItems(item, historySince, 24))
      .filter((candidate) => !areLikelySameEvent(item, candidate, company))
      .slice(0, 12);
    return { item, corroboratingItems, company, priorItems };
  }
}

function emptyProcessingSummary(): ProcessingSummary {
  return { analyzedCount: 0, skippedCount: 0, errorCount: 0, highCount: 0, urgentCount: 0 };
}

function observe(values: number[], value: number): void {
  values.push(Math.round(value * 1_000) / 1_000);
  if (values.length > 500) values.splice(0, values.length - 500);
}

function latencySnapshot(values: readonly number[], threshold: number): LatencySnapshot {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
    breachCount: sorted.filter((value) => value > threshold).length,
  };
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * quantile))] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withEffectiveMarketMateriality(
  assessment: ImpactAssessment,
  effectiveMarketMateriality: number,
): ImpactAssessment {
  const current = assessment.marketMateriality ?? assessment.materiality;
  if (effectiveMarketMateriality <= current) return assessment;
  return {
    ...assessment,
    materiality: effectiveMarketMateriality,
    marketMateriality: effectiveMarketMateriality,
  };
}
