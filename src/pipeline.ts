import { randomUUID } from "node:crypto";
import type { CatalystAnalyzer } from "./analysis/analyzer.js";
import { decideAlert } from "./analysis/policy.js";
import type { AlertService } from "./alerts/service.js";
import type { AppConfig } from "./config.js";
import type { SignalStore, SourceStateUpdate } from "./store.js";
import type { EvidenceContext, NormalizedItem, SourceAdapter } from "./types.js";
import { findWatchCompany, isCatalystCandidate, jaccardSimilarity } from "./utils.js";

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
  urgentCount: number;
  alreadyRunning: boolean;
}

export interface PolicyReconciliationSummary {
  checkedCount: number;
  updatedCount: number;
  errorCount: number;
}

export class MonitorPipeline {
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: SignalStore,
    private readonly sources: SourceAdapter[],
    private readonly analyzer: CatalystAnalyzer,
    private readonly alerts: AlertService,
    private readonly logger: PipelineLogger,
  ) {}

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
        const decision = decideAlert(
          entry.analysis.assessment,
          context,
          entry.analysis.method,
          this.config.alertPolicy,
        );
        const reasonsChanged = JSON.stringify(decision.reasons) !== JSON.stringify(entry.analysis.policyReasons);
        if (decision.score === entry.analysis.policyScore
          && decision.tier === entry.analysis.alertTier
          && !reasonsChanged) continue;
        await this.db.saveAnalysis({
          ...entry.analysis,
          policyScore: decision.score,
          alertTier: decision.tier,
          policyReasons: decision.reasons,
        });
        updatedCount += 1;
      } catch (error) {
        errorCount += 1;
        this.logger.warn({
          itemId: entry.item.id,
          error: error instanceof Error ? error.message : String(error),
        }, "stored signal policy reconciliation failed");
      }
    }
    const summary = { checkedCount, updatedCount, errorCount };
    this.logger.info(summary, "stored signal policies reconciled");
    return summary;
  }

  async run(): Promise<ScanSummary> {
    const startedAt = new Date().toISOString();
    if (this.running) return emptySummary(startedAt, true, this.sources.length);
    this.running = true;
    const leaseId = randomUUID();
    let ownsLease = false;
    let fetchedCount = 0;
    let insertedCount = 0;
    let analyzedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let urgentCount = 0;
    try {
      if (this.db.tryAcquireScanLease) {
        const leaseExpiresAt = new Date(Date.now() + 6 * 60_000).toISOString();
        ownsLease = await this.db.tryAcquireScanLease(leaseId, leaseExpiresAt);
        if (!ownsLease) return emptySummary(startedAt, true, this.sources.length);
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
          return result.items;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sourceStateUpdates.push({
            sourceId: source.descriptor.id,
            cursor,
            error: message,
            fetchedAt: new Date().toISOString(),
          });
          this.logger.warn({ source: source.descriptor.id, error: message }, "source fetch failed");
          throw error;
        }
      }));

      if (this.db.saveSourceStates) await this.db.saveSourceStates(sourceStateUpdates);
      else {
        await Promise.all(sourceStateUpdates.map((state) => this.db.saveSourceState(
          state.sourceId,
          state.cursor,
          state.error,
          state.fetchedAt,
        )));
      }

      const fetchedItems: NormalizedItem[] = [];
      for (const fetchResult of fetches) {
        if (fetchResult.status === "rejected") {
          errorCount += 1;
          continue;
        }
        fetchedCount += fetchResult.value.length;
        fetchedItems.push(...fetchResult.value);
      }
      if (this.db.insertItems) insertedCount = await this.db.insertItems(fetchedItems);
      else for (const item of fetchedItems) if (await this.db.insertItem(item)) insertedCount += 1;

      for (const item of await this.db.getPendingItems(150)) {
        const combinedText = `${item.headline}\n${item.summary}`;
        if (!isCatalystCandidate(combinedText, this.config.watchlist)) {
          await this.db.markItem(item.id, "skipped");
          skippedCount += 1;
          continue;
        }
        try {
          const context = await this.buildContext(item);
          const result = await this.analyzer.analyze(context);
          const decision = decideAlert(result.assessment, context, result.method, this.config.alertPolicy);
          const analysis = {
            itemId: item.id,
            model: result.model,
            method: result.method,
            assessment: result.assessment,
            policyScore: decision.score,
            alertTier: decision.tier,
            policyReasons: decision.reasons,
            createdAt: new Date().toISOString(),
          } as const;
          await this.db.saveAnalysis(analysis);
          analyzedCount += 1;
          if (decision.tier === "urgent") {
            urgentCount += 1;
            const dispatch = await this.alerts.dispatch(item, analysis);
            this.logger.info({ itemId: item.id, ticker: result.assessment.ticker, dispatch }, "urgent signal processed");
          }
        } catch (error) {
          errorCount += 1;
          await this.db.markItem(item.id, "error");
          this.logger.error({ itemId: item.id, error: error instanceof Error ? error.message : String(error) }, "analysis failed");
        }
      }
    } finally {
      if (ownsLease && this.db.releaseScanLease) {
        await Promise.resolve(this.db.releaseScanLease(leaseId)).catch((error: unknown) => {
          this.logger.warn({ error: error instanceof Error ? error.message : String(error) }, "scan lease release failed");
        });
      }
      this.running = false;
    }
    const summary = {
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceCount: this.sources.length,
      fetchedCount,
      insertedCount,
      analyzedCount,
      skippedCount,
      errorCount,
      urgentCount,
      alreadyRunning: false,
    };
    this.logger.info(summary, "scan complete");
    return summary;
  }

  private async buildContext(item: NormalizedItem): Promise<EvidenceContext> {
    const since = new Date(new Date(item.publishedAt).getTime() - 24 * 60 * 60 * 1000).toISOString();
    const allCandidates = await this.db.findCorroboratingItems(item, since);
    const nctIds = new Set(`${item.headline} ${item.summary}`.match(/NCT\d{8}/gi)?.map((id) => id.toUpperCase()) ?? []);
    const corroboratingItems = allCandidates.filter((candidate) => {
      const candidateNctIds = `${candidate.headline} ${candidate.summary}`.match(/NCT\d{8}/gi)?.map((id) => id.toUpperCase()) ?? [];
      const sharesNct = candidateNctIds.some((id) => nctIds.has(id));
      return sharesNct || jaccardSimilarity(item.headline, candidate.headline) >= 0.24;
    }).slice(0, 5);
    const company = findWatchCompany(`${item.headline} ${item.summary}`, this.config.watchlist);
    return { item, corroboratingItems, company };
  }
}

function emptySummary(startedAt: string, alreadyRunning: boolean, sourceCount: number): ScanSummary {
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    sourceCount,
    fetchedCount: 0,
    insertedCount: 0,
    analyzedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    urgentCount: 0,
    alreadyRunning,
  };
}
