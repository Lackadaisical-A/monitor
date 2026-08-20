import type { CatalystAnalyzer } from "./analysis/analyzer.js";
import { decideAlert } from "./analysis/policy.js";
import type { AlertService } from "./alerts/service.js";
import type { AppConfig } from "./config.js";
import type { SignalDatabase } from "./db.js";
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

export class MonitorPipeline {
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: SignalDatabase,
    private readonly sources: SourceAdapter[],
    private readonly analyzer: CatalystAnalyzer,
    private readonly alerts: AlertService,
    private readonly logger: PipelineLogger,
  ) {}

  async run(): Promise<ScanSummary> {
    const startedAt = new Date().toISOString();
    if (this.running) return emptySummary(startedAt, true, this.sources.length);
    this.running = true;
    let fetchedCount = 0;
    let insertedCount = 0;
    let analyzedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let urgentCount = 0;
    try {
      const fetches = await Promise.allSettled(this.sources.map(async (source) => {
        const cursor = this.db.getSourceCursor(source.descriptor.id);
        try {
          const result = await source.fetch(cursor);
          this.db.saveSourceState(source.descriptor.id, result.cursor ?? null, null);
          this.logger.info({ source: source.descriptor.id, count: result.items.length, diagnostics: result.diagnostics }, "source fetched");
          return result.items;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.db.saveSourceState(source.descriptor.id, cursor, message);
          this.logger.warn({ source: source.descriptor.id, error: message }, "source fetch failed");
          throw error;
        }
      }));

      for (const fetchResult of fetches) {
        if (fetchResult.status === "rejected") {
          errorCount += 1;
          continue;
        }
        fetchedCount += fetchResult.value.length;
        for (const item of fetchResult.value) {
          if (this.db.insertItem(item)) insertedCount += 1;
        }
      }

      for (const item of this.db.getPendingItems(150)) {
        const combinedText = `${item.headline}\n${item.summary}`;
        if (!isCatalystCandidate(combinedText, this.config.watchlist)) {
          this.db.markItem(item.id, "skipped");
          skippedCount += 1;
          continue;
        }
        try {
          const context = this.buildContext(item);
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
          this.db.saveAnalysis(analysis);
          analyzedCount += 1;
          if (decision.tier === "urgent") {
            urgentCount += 1;
            const dispatch = await this.alerts.dispatch(item, analysis);
            this.logger.info({ itemId: item.id, ticker: result.assessment.ticker, dispatch }, "urgent signal processed");
          }
        } catch (error) {
          errorCount += 1;
          this.db.markItem(item.id, "error");
          this.logger.error({ itemId: item.id, error: error instanceof Error ? error.message : String(error) }, "analysis failed");
        }
      }
    } finally {
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

  private buildContext(item: NormalizedItem): EvidenceContext {
    const since = new Date(new Date(item.publishedAt).getTime() - 24 * 60 * 60 * 1000).toISOString();
    const allCandidates = this.db.findCorroboratingItems(item, since);
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
