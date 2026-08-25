import { afterEach, describe, expect, it } from "vitest";
import type { CatalystAnalyzer } from "../src/analysis/analyzer.js";
import type { AlertService } from "../src/alerts/service.js";
import type { AppConfig } from "../src/config.js";
import { SignalDatabase } from "../src/db.js";
import { MonitorPipeline } from "../src/pipeline.js";
import type { EvidenceContext, ImpactAssessment, NormalizedItem, SourceAdapter } from "../src/types.js";

let db: SignalDatabase | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("MonitorPipeline policy reconciliation", () => {
  it("re-scores a stored clinical hold after its source becomes primary", async () => {
    db = new SignalDatabase(":memory:");
    const item = clinicalHoldItem();
    db.insertItem(item);
    db.saveAnalysis({
      itemId: item.id,
      model: "test-model",
      method: "openai",
      assessment: clinicalHoldAssessment(),
      policyScore: 69,
      alertTier: "watch",
      policyReasons: ["no primary evidence or independent non-social corroboration"],
      createdAt: new Date().toISOString(),
    });
    db.syncSourceDescriptors([{
      id: item.source.id,
      name: item.source.name,
      type: "company_ir",
      tier: "primary",
    }]);
    const pipeline = new MonitorPipeline(
      {
        watchlist: [{
          ticker: "RGNX",
          company: "Regenxbio",
          aliases: ["REGENXBIO Inc."],
          marketCapBand: "small",
          xAccounts: [],
          programs: ["RGX-121"],
        }],
        alertPolicy: { dryRun: false, minMateriality: 88, minConfidence: 0.86, cooldownMinutes: 240 },
      } as unknown as AppConfig,
      db,
      [],
      { analyze: async () => { throw new Error("not used"); } } as CatalystAnalyzer,
      {} as AlertService,
      { info: () => {}, warn: () => {}, error: () => {} },
    );

    const result = await pipeline.reconcileStoredPolicies();

    expect(result).toEqual({ checkedCount: 1, updatedCount: 1, errorCount: 0 });
    expect(db.getItem(item.id)?.source).toMatchObject({ type: "company_ir", tier: "primary" });
    expect(db.getAnalysis(item.id)).toMatchObject({
      policyScore: 86,
      alertTier: "urgent",
      policyReasons: ["passed primary-source severe negative catalyst escalation gate"],
    });
  });
});

describe("MonitorPipeline processing", () => {
  it("processes primary announcements ahead of registry backlog with bounded concurrency", async () => {
    db = new SignalDatabase(":memory:");
    const items = [
      ...Array.from({ length: 6 }, (_, index) => candidateItem(`registry-${index}`, "clinical_trials", index)),
      candidateItem("primary-release", "company_ir", 10),
    ];
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const analyzer: CatalystAnalyzer = {
      analyze: async (context) => {
        order.push(context.item.id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { assessment: routineAssessment(), method: "openai", model: "test" };
      },
    };
    const pipeline = processingPipeline(db, source(items), analyzer, 3);

    const summary = await pipeline.run();

    expect(order[0]).toBe("primary-release");
    expect(maxActive).toBe(3);
    expect(summary).toMatchObject({ analyzedCount: 7, errorCount: 0, alreadyRunning: false });
  });

  it("retries a transient analysis failure and retains historical disclosures in context", async () => {
    db = new SignalDatabase(":memory:");
    const prior = candidateItem("prior-update", "company_ir", -1);
    prior.publishedAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    prior.headline = "Example Bio reports prior cash runway update";
    prior.summary = "The company reported financial results and an updated cash runway.";
    db.insertItem(prior);
    db.saveAnalysis({
      itemId: prior.id,
      model: "test",
      method: "openai",
      assessment: routineAssessment(),
      policyScore: 55,
      alertTier: "watch",
      policyReasons: [],
      createdAt: new Date().toISOString(),
      eventKey: "EXBI:prior",
      eventAnchorAt: prior.publishedAt,
      analysisVersion: 2,
    });
    const current = candidateItem("current-update", "company_ir", 0);
    current.headline = "Example Bio completes a new FDA IND submission";
    let attempts = 0;
    const analyzedContexts: EvidenceContext[] = [];
    const analyzer: CatalystAnalyzer = {
      analyze: async (context) => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary model timeout");
        analyzedContexts.push(context);
        return { assessment: routineAssessment(), method: "openai", model: "test" };
      },
    };
    const pipeline = processingPipeline(db, source([current]), analyzer, 1);

    expect(await pipeline.run()).toMatchObject({ errorCount: 1, analyzedCount: 0 });
    db.sqlite.prepare("UPDATE items SET next_attempt_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), current.id);
    expect(await pipeline.run()).toMatchObject({ errorCount: 0, analyzedCount: 1 });

    expect(attempts).toBe(2);
    expect(analyzedContexts.at(-1)?.priorItems?.map((item) => item.id)).toContain(prior.id);
    expect(db.getAnalysis(current.id)?.analysisVersion).toBe(2);
  });

  it("excludes an initial source backfill from steady-state analysis latency", async () => {
    db = new SignalDatabase(":memory:");
    const initial = candidateItem("initial-backfill", "outlet", -10);
    const current = candidateItem("steady-state-item", "outlet", 0);
    let fetchCount = 0;
    const adapter: SourceAdapter = {
      descriptor: { id: "latency-source", name: "Latency source", type: "outlet", tier: "secondary" },
      fetch: async () => ({
        items: fetchCount++ === 0 ? [initial] : [current],
        cursor: new Date().toISOString(),
      }),
    };
    const analyzer: CatalystAnalyzer = {
      analyze: async () => ({ assessment: routineAssessment(), method: "openai", model: "test" }),
    };
    const pipeline = processingPipeline(db, adapter, analyzer, 1);

    await pipeline.run();
    expect(pipeline.telemetry().analysisLatencySeconds.count).toBe(0);
    await pipeline.run();
    expect(pipeline.telemetry().analysisLatencySeconds.count).toBe(1);
  });
});

function processingPipeline(
  database: SignalDatabase,
  adapter: SourceAdapter,
  analyzer: CatalystAnalyzer,
  concurrency: number,
): MonitorPipeline {
  return new MonitorPipeline(
    {
      watchlist: [{
        ticker: "EXBI",
        company: "Example Bio",
        aliases: [],
        marketCapBand: "small",
        xAccounts: [],
        programs: ["EX-101"],
      }],
      analysis: { concurrency, batchSize: 100, historyDays: 180 },
      alertPolicy: {
        dryRun: false,
        highMinMateriality: 70,
        highMinConfidence: 0.8,
        minMateriality: 88,
        minConfidence: 0.86,
        cooldownMinutes: 240,
        maxAgeMinutes: 30,
      },
    } as unknown as AppConfig,
    database,
    [adapter],
    analyzer,
    { dispatch: async () => ({ attempted: 0, sent: 0, failed: 0, dryRun: false, suppressedReason: null }) } as unknown as AlertService,
    { info: () => {}, warn: () => {}, error: () => {} },
  );
}

function source(items: NormalizedItem[]): SourceAdapter {
  return {
    descriptor: { id: "test-source", name: "Test source", type: "outlet", tier: "secondary" },
    fetch: async () => ({ items, cursor: new Date().toISOString() }),
  };
}

function candidateItem(id: string, type: NormalizedItem["source"]["type"], offset: number): NormalizedItem {
  const timestamp = new Date(Date.now() + offset * 1_000).toISOString();
  return {
    id,
    externalId: id,
    source: {
      id: `${type}-source`,
      name: type,
      type,
      tier: type === "outlet" ? "secondary" : "primary",
    },
    headline: `Example Bio clinical trial update ${id}`,
    summary: "The company reported an FDA regulatory update for EX-101.",
    url: `https://example.test/${id}`,
    author: null,
    publishedAt: timestamp,
    discoveredAt: timestamp,
    companyHint: "Example Bio",
    tickerHint: "EXBI",
    raw: {},
  };
}

function routineAssessment(): ImpactAssessment {
  return {
    isBiotechCatalyst: true,
    companyName: "Example Bio",
    ticker: "EXBI",
    eventType: "trial_update",
    trialPhase: "phase_2",
    trialName: "EX-101",
    indication: "Example disease",
    resultDirection: "unclear",
    stockDirection: "neutral",
    materiality: 55,
    confidence: 0.9,
    probabilityPositiveMove: 0.5,
    expectedMoveLowPct: -4,
    expectedMoveBasePct: 0,
    expectedMoveHighPct: 4,
    timeHorizon: "intraday",
    primaryEndpointMet: "not_reported",
    statisticalStrength: "not_reported",
    safetyAssessment: "not_reported",
    noveltyVsPriorDisclosure: "incremental",
    rationale: "Incremental update.",
    evidence: ["The company reported an update."],
    uncertainty: [],
    disconfirmingEvidence: [],
    requiresHumanReview: false,
  };
}

function clinicalHoldItem(): NormalizedItem {
  const timestamp = new Date().toISOString();
  return {
    id: "rgnx-hold",
    externalId: "release-1",
    source: {
      id: "watchlist-press-releases",
      name: "Watchlist company press releases",
      type: "outlet",
      tier: "secondary",
    },
    headline: "REGENXBIO Announces Regulatory Update on RGX-121 for MPS II",
    summary: "The FDA placed a clinical hold on RGX-121 and the company does not expect a near-term BLA resubmission.",
    url: "https://example.test/rgnx-hold",
    author: "PR Newswire via QuoteMedia",
    publishedAt: timestamp,
    discoveredAt: timestamp,
    companyHint: "Regenxbio",
    tickerHint: "RGNX",
    raw: {},
  };
}

function clinicalHoldAssessment(): ImpactAssessment {
  return {
    isBiotechCatalyst: true,
    companyName: "Regenxbio",
    ticker: "RGNX",
    eventType: "regulatory_update",
    trialPhase: "unknown",
    trialName: "CAMPSIITE",
    indication: "MPS II",
    resultDirection: "negative",
    stockDirection: "bearish",
    materiality: 82,
    confidence: 0.9,
    probabilityPositiveMove: 0.12,
    expectedMoveLowPct: -20,
    expectedMoveBasePct: -10,
    expectedMoveHighPct: -4,
    timeHorizon: "next_session",
    primaryEndpointMet: "not_reported",
    statisticalStrength: "not_reported",
    safetyAssessment: "concerning",
    noveltyVsPriorDisclosure: "new",
    rationale: "The FDA clinical hold prevents a near-term BLA resubmission.",
    evidence: ["The FDA placed RGX-121 on clinical hold."],
    uncertainty: ["The FDA hold letter is pending."],
    disconfirmingEvidence: ["The findings were asymptomatic."],
    requiresHumanReview: false,
  };
}
