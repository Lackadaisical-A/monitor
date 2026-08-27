import { afterEach, describe, expect, it } from "vitest";
import { SignalDatabase } from "../src/db.js";
import { clinicalSurpriseScore, timelineEventsFromAnalysis } from "../src/timeline.js";
import type { AnalysisRecord, ImpactAssessment, NormalizedItem } from "../src/types.js";

let db: SignalDatabase | null = null;
afterEach(() => { db?.close(); db = null; });

describe("catalyst timeline", () => {
  it("captures explicit quarter guidance without inventing an outcome probability", () => {
    const item = signalItem(
      "guided-readout",
      "2026-08-25T12:00:00.000Z",
      "Example Bio expects Phase 3 ABC-101 topline results in Q1 2027.",
    );
    const events = timelineEventsFromAnalysis(item, analysis(item, assessment()));
    const upcoming = events.find((event) => event.status === "upcoming");

    expect(upcoming).toMatchObject({
      eventType: "trial_topline",
      datePrecision: "quarter",
      dateLabel: "Q1 2027",
      eventDate: "2027-03-31T12:00:00.000Z",
      expectedSuccessProbability: null,
      basis: "company_guidance",
    });
  });

  it("does not turn a historical month into a future milestone", () => {
    const item = signalItem(
      "historical-month",
      "2026-08-25T12:00:00.000Z",
      "The FDA granted Fast Track designation in August 2026 and the company will continue collecting clinical data.",
    );
    const events = timelineEventsFromAnalysis(item, analysis(item, assessment()));

    expect(events.filter((event) => event.status === "upcoming")).toEqual([]);
  });

  it("does not treat a routine conference appearance as a clinical readout", () => {
    const item = signalItem(
      "conference-event",
      "2026-08-25T12:00:00.000Z",
      "The October 2026 symposium will feature leading clinical experts and a company presentation.",
    );
    const events = timelineEventsFromAnalysis(item, analysis(item, assessment()));

    expect(events.filter((event) => event.status === "upcoming")).toEqual([]);
  });

  it("uses structured model expectations and keeps them as a pre-event snapshot", () => {
    const item = signalItem(
      "planned-submission",
      "2026-08-25T12:00:00.000Z",
      "Example Bio plans an FDA submission in September.",
    );
    const futureMilestones: NonNullable<ImpactAssessment["futureMilestones"]> = [{
      title: "ABC-101 FDA submission",
      eventType: "regulatory_update",
      program: "ABC-101",
      indication: "Rare disease",
      expectedDate: "2026-09-30",
      datePrecision: "month",
      dateLabel: "September 2026",
      expectedDirection: "positive",
      expectedOutcome: "A complete submission accepted for review.",
      anticipatedMateriality: 72,
      expectedSuccessProbability: 0.74,
      expectationConfidence: 0.68,
      sourceEvidence: "The company plans to submit in September.",
    }];
    const events = timelineEventsFromAnalysis(item, analysis(item, assessment({ futureMilestones })));
    const expected = events.find((event) => event.expectedSuccessProbability === 0.74);

    expect(expected).toMatchObject({
      eventDate: "2026-09-30T12:00:00.000Z",
      anticipatedMateriality: 72,
      expectedDirection: "positive",
      expectationAsOf: item.publishedAt,
    });
  });

  it("creates authoritative registry schedule milestones from ClinicalTrials.gov raw data", () => {
    const item = {
      ...signalItem("nct-update", "2026-08-25T12:00:00.000Z", "ClinicalTrials.gov record updated"),
      source: { id: "clinicaltrials-gov", name: "ClinicalTrials.gov", type: "clinical_trials", tier: "primary" } as const,
      raw: {
        protocolSection: {
          identificationModule: { nctId: "NCT12345678", briefTitle: "ABC-101 pivotal study" },
          statusModule: {
            overallStatus: "RECRUITING",
            primaryCompletionDateStruct: { date: "2027-06", type: "ESTIMATED" },
          },
          armsInterventionsModule: { interventions: [{ name: "ABC-101" }] },
        },
      },
    } satisfies NormalizedItem;
    const events = timelineEventsFromAnalysis(item, analysis(item, assessment()));

    expect(events.find((event) => event.basis === "registry_schedule")).toMatchObject({
      title: "ABC-101 pivotal study: primary completion",
      eventDate: "2027-06-30T12:00:00.000Z",
      datePrecision: "month",
      sourceName: "ClinicalTrials.gov",
    });
  });

  it("links a result to an earlier expectation and removes the resolved duplicate", () => {
    db = new SignalDatabase(":memory:");
    const expectedItem = signalItem("expectation", "2026-01-10T12:00:00.000Z", "ABC-101 topline expected in Q3 2026.");
    const expectedAssessment = assessment({
      futureMilestones: [{
        title: "ABC-101 Phase 3 topline results",
        eventType: "trial_topline",
        program: "ABC-101",
        indication: "Rare disease",
        expectedDate: "2026-09-30",
        datePrecision: "quarter",
        dateLabel: "Q3 2026",
        expectedDirection: "positive",
        expectedOutcome: "The primary endpoint is expected to be met.",
        anticipatedMateriality: 92,
        expectedSuccessProbability: 0.7,
        expectationConfidence: 0.65,
        sourceEvidence: "Topline results are expected in Q3 2026.",
      }],
    });
    db.insertItem(expectedItem);
    db.upsertTimelineEvents(timelineEventsFromAnalysis(expectedItem, analysis(expectedItem, expectedAssessment, "expected-event")));

    const resultItem = signalItem("result", "2026-09-15T12:00:00.000Z", "ABC-101 Phase 3 primary endpoint met");
    db.insertItem(resultItem);
    db.upsertTimelineEvents(timelineEventsFromAnalysis(resultItem, analysis(
      resultItem,
      assessment({ resultDirection: "positive" }),
      "completed-event",
    )));

    const timeline = db.listTimelineEvents();
    expect(timeline).toHaveLength(2);
    const completed = timeline.find((event) => event.eventKey === "completed-event");
    expect(completed).toMatchObject({
      expectationEventId: expect.stringMatching(/^tle_/),
      expectedSuccessProbability: 0.7,
      clinicalSurpriseScore: 30,
      anticipatedMateriality: 92,
    });
    expect(timeline.some((event) => event.status === "upcoming" && event.program === "ABC-101")).toBe(false);
  });

  it("collapses duplicate guidance across reports and prunes stale extraction for an item", () => {
    db = new SignalDatabase(":memory:");
    const first = signalItem("guidance-one", "2026-02-01T12:00:00.000Z", "ABC-101 results are expected in Q4 2026.");
    const second = signalItem("guidance-two", "2026-02-02T12:00:00.000Z", "The company expects ABC-101 topline results in Q4 2026.");
    db.insertItem(first);
    db.insertItem(second);
    const firstEvents = timelineEventsFromAnalysis(first, analysis(first, assessment(), "guidance-one-event"));
    db.upsertTimelineEvents(firstEvents);
    db.upsertTimelineEvents(timelineEventsFromAnalysis(second, analysis(second, assessment(), "guidance-two-event")));

    expect(db.listTimelineEvents().filter((event) => event.status === "upcoming")).toHaveLength(1);
    db.upsertTimelineEvents(firstEvents.filter((event) => event.status === "completed"));
    expect(db.listTimelineEvents().filter((event) => event.status === "upcoming")).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM timeline_events WHERE item_id = ? AND status = 'upcoming'")
      .get(first.id)).toEqual({ count: 0 });
  });

  it("updates schedule guidance without rewriting the first expectation snapshot", () => {
    db = new SignalDatabase(":memory:");
    const first = signalItem("initial-guidance", "2026-01-10T12:00:00.000Z", "ABC-101 results are expected in Q3 2026.");
    const revision = signalItem("revised-guidance", "2026-05-10T12:00:00.000Z", "ABC-101 results are now expected in Q4 2026.");
    const milestone = (expectedDate: string, dateLabel: string, probability: number) => ({
      title: "ABC-101 pivotal data readout",
      eventType: "trial_topline" as const,
      program: "ABC-101",
      indication: "Rare disease",
      expectedDate,
      datePrecision: "quarter" as const,
      dateLabel,
      expectedDirection: "positive" as const,
      expectedOutcome: "The primary endpoint is expected to be met.",
      anticipatedMateriality: 92,
      expectedSuccessProbability: probability,
      expectationConfidence: 0.65,
      sourceEvidence: "Company guidance.",
    });
    db.insertItem(first);
    db.insertItem(revision);
    db.upsertTimelineEvents(timelineEventsFromAnalysis(first, analysis(
      first,
      assessment({ futureMilestones: [milestone("2026-09-30", "Q3 2026", 0.7)] }),
      "initial-guidance-event",
    )));
    db.upsertTimelineEvents(timelineEventsFromAnalysis(revision, analysis(
      revision,
      assessment({ futureMilestones: [milestone("2026-12-31", "Q4 2026", 0.9)] }),
      "revised-guidance-event",
    )));

    const upcoming = db.listTimelineEvents().find((event) => event.status === "upcoming");
    expect(upcoming).toMatchObject({
      eventDate: "2026-12-31T12:00:00.000Z",
      initialEventDate: "2026-09-30T12:00:00.000Z",
      expectedSuccessProbability: 0.7,
      expectationAsOf: first.publishedAt,
    });
  });

  it("scores clinical surprise against the frozen probability", () => {
    expect(clinicalSurpriseScore(0.8, "negative")).toBe(-80);
    expect(clinicalSurpriseScore(0.4, "positive")).toBe(60);
    expect(clinicalSurpriseScore(null, "positive")).toBeNull();
  });
});

function signalItem(id: string, publishedAt: string, summary: string): NormalizedItem {
  return {
    id,
    externalId: id,
    source: { id: "example-ir", name: "Example Bio IR", type: "company_ir", tier: "primary" },
    headline: summary,
    summary,
    url: `https://example.test/${id}`,
    author: "Example Bio",
    publishedAt,
    discoveredAt: publishedAt,
    companyHint: "Example Bio",
    tickerHint: "EXBI",
    provenance: "direct_primary",
    raw: {},
  };
}

function analysis(
  item: NormalizedItem,
  value: ImpactAssessment,
  eventKey = `${item.id}-event`,
): AnalysisRecord {
  return {
    itemId: item.id,
    model: "test-model",
    method: "openai",
    assessment: value,
    policyScore: value.materiality,
    alertTier: "high",
    policyReasons: [],
    createdAt: item.discoveredAt,
    eventKey,
    eventAnchorAt: item.publishedAt,
    analysisVersion: 2,
  };
}

function assessment(overrides: Partial<ImpactAssessment> = {}): ImpactAssessment {
  return {
    isBiotechCatalyst: true,
    companyName: "Example Bio",
    ticker: "EXBI",
    eventType: "trial_topline",
    trialPhase: "phase_3",
    trialName: "ABC-101",
    indication: "Rare disease",
    resultDirection: "unclear",
    stockDirection: "unclear",
    materiality: 82,
    confidence: 0.9,
    probabilityPositiveMove: 0.55,
    expectedMoveLowPct: -20,
    expectedMoveBasePct: 3,
    expectedMoveHighPct: 25,
    timeHorizon: "next_session",
    primaryEndpointMet: "not_reported",
    statisticalStrength: "not_reported",
    safetyAssessment: "not_reported",
    noveltyVsPriorDisclosure: "new",
    rationale: "A pivotal program update.",
    evidence: [],
    uncertainty: [],
    disconfirmingEvidence: [],
    requiresHumanReview: false,
    ...overrides,
  };
}
