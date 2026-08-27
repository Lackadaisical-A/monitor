import type { MarketDataProvider } from "./market-data/alpaca.js";
import type { SignalStore } from "./store.js";
import type { OutcomeAudit } from "./types.js";

export const OUTCOME_CALIBRATION_VERSION = 2;

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
      // Each event now needs both company and XBI bars, so halve the event batch to
      // keep Alpaca request volume close to the pre-benchmark audit budget.
      const candidates = await this.db.listOutcomeAuditCandidates(Math.max(1, Math.floor(this.batchSize / 2)), auditedBefore);
      if (!candidates.length) return emptySummary(false);
      const requests = candidates.flatMap((entry) => {
        const assessment = entry.analysis?.assessment;
        if (!entry.analysis?.eventKey || !assessment?.ticker) return [];
        const publishedAt = entry.analysis.eventAnchorAt ?? entry.item.publishedAt;
        return [
          { id: entry.item.id, ticker: assessment.ticker, publishedAt },
          { id: benchmarkRequestId(entry.item.id, "XBI"), ticker: "XBI", publishedAt },
        ];
      });
      const movements = await this.marketData.getMovements(requests);
      let recorded = 0;
      let finalized = 0;
      for (const entry of candidates) {
        const analysis = entry.analysis;
        const movement = movements.get(entry.item.id);
        if (!analysis?.eventKey || !movement) continue;
        const assessment = analysis.assessment;
        const benchmark = movements.get(benchmarkRequestId(entry.item.id, "XBI"));
        const benchmarkReturnPct = benchmark?.changePct ?? null;
        const calibration = calculateOutcomeCalibration({
          initialMateriality: assessment.marketMateriality ?? assessment.materiality,
          actualReturnPct: movement.changePct,
          benchmarkReturnPct,
          expectedMoveLowPct: assessment.expectedMoveLowPct,
          expectedMoveBasePct: assessment.expectedMoveBasePct,
          expectedMoveHighPct: assessment.expectedMoveHighPct,
        });
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
          initialMateriality: assessment.marketMateriality ?? assessment.materiality,
          actualReturnPct: movement.changePct,
          benchmarkReturnPct,
          benchmarkBasis: benchmark ? "xbi" : "unavailable",
          abnormalReturnPct: calibration.abnormalReturnPct,
          marketSurpriseScore: calibration.marketSurpriseScore,
          surpriseAdjustedMateriality: calibration.surpriseAdjustedMateriality,
          directionCorrect: directionCorrect(assessment.stockDirection, movement.changePct),
          abnormalDirectionCorrect: benchmark
            ? directionCorrect(assessment.stockDirection, calibration.abnormalReturnPct ?? movement.changePct)
            : null,
          expectedRangeHit: movement.changePct >= Math.min(assessment.expectedMoveLowPct, assessment.expectedMoveHighPct)
            && movement.changePct <= Math.max(assessment.expectedMoveLowPct, assessment.expectedMoveHighPct),
          movementWindow: movement.window,
          status: movement.status,
          priceStartAt: movement.priceStartAt,
          priceEndAt: movement.priceEndAt,
          auditedAt: movement.fetchedAt,
          calibrationVersion: OUTCOME_CALIBRATION_VERSION,
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
  const benchmarked = audits.filter((audit) => audit.abnormalReturnPct !== null);
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
    benchmarkedCount: benchmarked.length,
    meanAbnormalReturnPct: benchmarked.length
      ? benchmarked.reduce((sum, audit) => sum + (audit.abnormalReturnPct ?? 0), 0) / benchmarked.length
      : null,
    meanMarketSurpriseScore: audits.length
      ? audits.reduce((sum, audit) => sum + audit.marketSurpriseScore, 0) / audits.length
      : null,
    meanSurpriseAdjustedMateriality: audits.length
      ? audits.reduce((sum, audit) => sum + audit.surpriseAdjustedMateriality, 0) / audits.length
      : null,
  };
}

export interface OutcomeCalibrationInput {
  initialMateriality: number;
  actualReturnPct: number;
  benchmarkReturnPct: number | null;
  expectedMoveLowPct: number;
  expectedMoveBasePct: number;
  expectedMoveHighPct: number;
}

export function calculateOutcomeCalibration(input: OutcomeCalibrationInput): {
  abnormalReturnPct: number | null;
  marketSurpriseScore: number;
  surpriseAdjustedMateriality: number;
} {
  const abnormalReturnPct = input.benchmarkReturnPct === null
    ? null
    : decimal(input.actualReturnPct - input.benchmarkReturnPct);
  const scoringReturn = abnormalReturnPct ?? input.actualReturnPct;
  const scenarioWidth = Math.max(4, Math.abs(input.expectedMoveHighPct - input.expectedMoveLowPct) / 2);
  const marketSurpriseScore = clamp(
    Math.round(((scoringReturn - input.expectedMoveBasePct) / scenarioWidth) * 50),
    -100,
    100,
  );
  const expectedMagnitude = Math.max(
    4,
    Math.abs(input.expectedMoveBasePct),
    (Math.abs(input.expectedMoveLowPct) + Math.abs(input.expectedMoveHighPct)) / 2,
  );
  const impactAdjustment = clamp(
    Math.round(((Math.abs(scoringReturn) / expectedMagnitude) - 1) * 18),
    -18,
    25,
  );
  const surpriseBonus = Math.min(8, Math.round(Math.abs(marketSurpriseScore) * 0.08));
  return {
    abnormalReturnPct,
    marketSurpriseScore,
    surpriseAdjustedMateriality: clamp(input.initialMateriality + impactAdjustment + surpriseBonus, 0, 100),
  };
}

function directionCorrect(direction: OutcomeAudit["predictedDirection"], actualReturnPct: number): boolean | null {
  if (direction === "bullish") return actualReturnPct > 0;
  if (direction === "bearish") return actualReturnPct < 0;
  if (direction === "neutral") return Math.abs(actualReturnPct) <= 2;
  return null;
}

function benchmarkRequestId(itemId: string, ticker: string): string {
  return `${itemId}:benchmark:${ticker.toLowerCase()}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function decimal(value: number): number {
  return Math.round(value * 100) / 100;
}

function emptySummary(alreadyRunning: boolean): OutcomeAuditSummary {
  return { checked: 0, recorded: 0, finalized: 0, unavailable: 0, alreadyRunning };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
