import type { MarketDataProvider } from "./market-data/alpaca.js";
import type { SignalStore } from "./store.js";
import type { OutcomeAudit } from "./types.js";

export interface OutcomeAuditSummary {
  checked: number;
  recorded: number;
  finalized: number;
  unavailable: number;
  alreadyRunning: boolean;
}

export interface OutcomeLogger {
  info(bindings: Record<string, unknown>, message?: string): void;
  warn(bindings: Record<string, unknown>, message?: string): void;
}

export interface OutcomeAuditorLike {
  run(): Promise<OutcomeAuditSummary>;
}

export class OutcomeAuditor implements OutcomeAuditorLike {
  private running = false;

  constructor(
    private readonly db: SignalStore,
    private readonly marketData: MarketDataProvider,
    private readonly logger: OutcomeLogger,
    private readonly intervalMinutes = 15,
    private readonly batchSize = 30,
  ) {}

  async run(): Promise<OutcomeAuditSummary> {
    if (this.running) return emptySummary(true);
    if (!this.marketData.configured || !this.db.listOutcomeAuditCandidates || !this.db.saveOutcomeAudit) {
      return emptySummary(false);
    }
    this.running = true;
    try {
      const auditedBefore = new Date(Date.now() - this.intervalMinutes * 60_000).toISOString();
      const candidates = await this.db.listOutcomeAuditCandidates(this.batchSize, auditedBefore);
      if (!candidates.length) return emptySummary(false);
      const movements = await this.marketData.getMovements(candidates.flatMap((entry) => {
        const assessment = entry.analysis?.assessment;
        if (!entry.analysis?.eventKey || !assessment?.ticker) return [];
        return [{
          id: entry.item.id,
          ticker: assessment.ticker,
          publishedAt: entry.analysis.eventAnchorAt ?? entry.item.publishedAt,
        }];
      }));
      let recorded = 0;
      let finalized = 0;
      for (const entry of candidates) {
        const analysis = entry.analysis;
        const movement = movements.get(entry.item.id);
        if (!analysis?.eventKey || !movement) continue;
        const assessment = analysis.assessment;
        const audit: OutcomeAudit = {
          eventKey: analysis.eventKey,
          itemId: entry.item.id,
          ticker: assessment.ticker,
          eventType: assessment.eventType,
          alertTier: analysis.alertTier,
          predictedDirection: assessment.stockDirection,
          probabilityPositiveMove: assessment.probabilityPositiveMove,
          expectedMoveLowPct: assessment.expectedMoveLowPct,
          expectedMoveBasePct: assessment.expectedMoveBasePct,
          expectedMoveHighPct: assessment.expectedMoveHighPct,
          actualReturnPct: movement.changePct,
          directionCorrect: directionCorrect(assessment.stockDirection, movement.changePct),
          expectedRangeHit: movement.changePct >= Math.min(assessment.expectedMoveLowPct, assessment.expectedMoveHighPct)
            && movement.changePct <= Math.max(assessment.expectedMoveLowPct, assessment.expectedMoveHighPct),
          movementWindow: movement.window,
          status: movement.status,
          priceStartAt: movement.priceStartAt,
          priceEndAt: movement.priceEndAt,
          auditedAt: movement.fetchedAt,
        };
        await this.db.saveOutcomeAudit(audit);
        recorded += 1;
        if (audit.status === "closed") finalized += 1;
      }
      const summary = {
        checked: candidates.length,
        recorded,
        finalized,
        unavailable: candidates.length - recorded,
        alreadyRunning: false,
      };
      this.logger.info(summary, "signal outcomes audited");
      return summary;
    } catch (error) {
      this.logger.warn({ error: errorMessage(error) }, "signal outcome audit failed");
      return emptySummary(false);
    } finally {
      this.running = false;
    }
  }
}

export function summarizeOutcomes(audits: readonly OutcomeAudit[]) {
  const directional = audits.filter((audit) => audit.directionCorrect !== null);
  const final = audits.filter((audit) => audit.status === "closed");
  const meanAbsoluteBaseError = audits.length
    ? audits.reduce((sum, audit) => sum + Math.abs(audit.actualReturnPct - audit.expectedMoveBasePct), 0) / audits.length
    : null;
  return {
    count: audits.length,
    finalCount: final.length,
    directionAccuracy: directional.length
      ? directional.filter((audit) => audit.directionCorrect).length / directional.length
      : null,
    expectedRangeCoverage: audits.length
      ? audits.filter((audit) => audit.expectedRangeHit).length / audits.length
      : null,
    meanAbsoluteBaseErrorPct: meanAbsoluteBaseError,
  };
}

function directionCorrect(direction: OutcomeAudit["predictedDirection"], actualReturnPct: number): boolean | null {
  if (direction === "bullish") return actualReturnPct > 0;
  if (direction === "bearish") return actualReturnPct < 0;
  if (direction === "neutral") return Math.abs(actualReturnPct) <= 2;
  return null;
}

function emptySummary(alreadyRunning: boolean): OutcomeAuditSummary {
  return { checked: 0, recorded: 0, finalized: 0, unavailable: 0, alreadyRunning };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
