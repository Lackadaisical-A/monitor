import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { isoDate, itemId, mapWithConcurrency, resolveWatchCompany } from "../utils.js";
import { fetchWithTimeout } from "./http.js";

interface ClinicalStudy {
  protocolSection?: {
    identificationModule?: {
      nctId?: string;
      briefTitle?: string;
      officialTitle?: string;
      organization?: { fullName?: string };
    };
    statusModule?: {
      overallStatus?: string;
      lastUpdatePostDateStruct?: { date?: string };
      resultsFirstPostDateStruct?: { date?: string };
      completionDateStruct?: { date?: string };
    };
    sponsorCollaboratorsModule?: {
      leadSponsor?: { name?: string; class?: string };
      collaborators?: Array<{ name?: string; class?: string }>;
    };
    designModule?: { phases?: string[]; studyType?: string; enrollmentInfo?: { count?: number; type?: string } };
    descriptionModule?: { briefSummary?: string; detailedDescription?: string };
    conditionsModule?: { conditions?: string[] };
    outcomesModule?: { primaryOutcomes?: Array<{ measure?: string; description?: string }> };
    armsInterventionsModule?: {
      interventions?: Array<{
        type?: string;
        name?: string;
        otherNames?: string[];
      }>;
    };
  };
  hasResults?: boolean;
  resultsSection?: unknown;
}

interface ClinicalTrialsResponse {
  studies?: ClinicalStudy[];
  totalCount?: number;
  nextPageToken?: string;
}

const SPONSOR_BATCH_SIZE = 20;
const BATCH_CONCURRENCY = 3;
const MAX_PAGES_PER_BATCH = 5;

export class ClinicalTrialsSource implements SourceAdapter {
  readonly descriptor = {
    id: "clinicaltrials-gov",
    name: "ClinicalTrials.gov",
    type: "clinical_trials",
    tier: "primary",
  } as const;

  constructor(
    private readonly watchlist: WatchCompany[],
    private readonly timeoutMs: number,
  ) {}

  async fetch(cursor: string | null): Promise<SourceFetchResult> {
    if (this.watchlist.length === 0) return { items: [], diagnostics: { reason: "watchlist_empty" } };
    const since = cursor && /^\d{4}-\d{2}-\d{2}$/.test(cursor)
      ? cursor
      : new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const batches = chunk(this.watchlist, SPONSOR_BATCH_SIZE);
    const batchResults = await mapWithConcurrency(
      batches,
      BATCH_CONCURRENCY,
      (batch) => this.fetchBatch(batch, since),
    );
    const successful = batchResults.filter((result): result is PromiseFulfilledResult<ClinicalBatchResult> => result.status === "fulfilled");
    if (successful.length === 0) {
      const firstFailure = batchResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw firstFailure?.reason ?? new Error("ClinicalTrials.gov returned no successful watchlist batches");
    }
    const studies = successful.flatMap((result) => result.value.studies);
    const discoveredAt = new Date().toISOString();
    const itemsById = new Map<string, NormalizedItem>();
    for (const study of studies) {
      const protocol = study.protocolSection;
      const identification = protocol?.identificationModule;
      const status = protocol?.statusModule;
      const nctId = identification?.nctId;
      const title = identification?.briefTitle ?? identification?.officialTitle;
      if (!nctId || !title) continue;
      const sponsor = protocol?.sponsorCollaboratorsModule?.leadSponsor?.name ?? identification.organization?.fullName ?? "";
      const phases = protocol?.designModule?.phases?.join("/") ?? "Unknown phase";
      const resultsDate = status?.resultsFirstPostDateStruct?.date;
      const isFreshResults = Boolean(resultsDate && resultsDate >= since);
      const headline = `ClinicalTrials.gov ${isFreshResults ? "results posted" : "record updated"}: ${title}`;
      const outcomes = protocol?.outcomesModule?.primaryOutcomes?.map((outcome) => `${outcome.measure ?? ""}: ${outcome.description ?? ""}`).join("\n") ?? "";
      const interventions = protocol?.armsInterventionsModule?.interventions ?? [];
      const interventionNames = interventions.flatMap((intervention) => [intervention.name, ...(intervention.otherNames ?? [])])
        .filter((value): value is string => Boolean(value));
      const summary = [
        `Sponsor: ${sponsor}`,
        `NCT ID: ${nctId}`,
        `Phase: ${phases}`,
        `Overall status: ${status?.overallStatus ?? "unknown"}`,
        `Has posted results: ${study.hasResults ? "yes" : "no"}`,
        `Conditions: ${protocol?.conditionsModule?.conditions?.join(", ") ?? "not reported"}`,
        `Enrollment: ${protocol?.designModule?.enrollmentInfo?.count ?? "not reported"}`,
        `Interventions: ${interventionNames.join(", ") || "not reported"}`,
        `Brief summary: ${protocol?.descriptionModule?.briefSummary ?? ""}`,
        outcomes ? `Registered primary outcomes: ${outcomes}` : "",
        // ClinicalTrials.gov results are structured and may be large. The raw record remains stored for audit.
        study.resultsSection ? `Posted results payload: ${JSON.stringify(study.resultsSection).slice(0, 10_000)}` : "",
      ].filter(Boolean).join("\n").slice(0, 16_000);
      const company = resolveWatchCompany({ headline: title, summary, companyHint: sponsor }, this.watchlist);
      if (company) learnCompanyPrograms(company, interventions);
      const url = `https://clinicaltrials.gov/study/${nctId}`;
      const version = status?.lastUpdatePostDateStruct?.date ?? resultsDate ?? discoveredAt.slice(0, 10);
      const item = {
        id: itemId(this.descriptor.id, `${nctId}:${version}`, url, headline),
        externalId: `${nctId}:${version}`,
        source: this.descriptor,
        headline,
        summary,
        url,
        author: sponsor || null,
        publishedAt: isoDate(status?.lastUpdatePostDateStruct?.date ?? resultsDate, new Date()),
        discoveredAt,
        companyHint: company?.company ?? (sponsor || null),
        tickerHint: company?.ticker ?? null,
        provenance: "registry",
        independenceKey: `registry:${nctId}`,
        raw: study,
      } satisfies NormalizedItem;
      itemsById.set(item.id, item);
    }
    const items = [...itemsById.values()];
    return {
      items,
      cursor: discoveredAt.slice(0, 10),
      diagnostics: {
        batchCount: batches.length,
        failedBatchCount: batchResults.length - successful.length,
        reportedStudyCount: successful.reduce((sum, result) => sum + result.value.totalCount, 0),
        truncatedBatchCount: successful.filter((result) => result.value.truncated).length,
        since,
      },
    };
  }

  private async fetchBatch(batch: WatchCompany[], since: string): Promise<ClinicalBatchResult> {
    const sponsorQuery = batch.map((company) => `\"${company.company.replaceAll('"', "")}\"`).join(" OR ");
    const studies: ClinicalStudy[] = [];
    let totalCount = 0;
    let nextPageToken: string | undefined;
    let page = 0;
    do {
      const url = new URL("https://clinicaltrials.gov/api/v2/studies");
      url.searchParams.set("format", "json");
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("countTotal", page === 0 ? "true" : "false");
      url.searchParams.set("query.spons", sponsorQuery);
      url.searchParams.set("filter.advanced", `AREA[LastUpdatePostDate]RANGE[${since}, MAX]`);
      url.searchParams.set("sort", "LastUpdatePostDate:desc");
      if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);
      const response = await fetchWithTimeout(url, {
        headers: { "User-Agent": "CatalystWatch/0.1 clinical trial monitor" },
      }, this.timeoutMs);
      const payload = await response.json() as ClinicalTrialsResponse;
      studies.push(...(payload.studies ?? []));
      totalCount = payload.totalCount ?? totalCount;
      nextPageToken = payload.nextPageToken;
      page += 1;
    } while (nextPageToken && page < MAX_PAGES_PER_BATCH);
    return { studies, totalCount, truncated: Boolean(nextPageToken) };
  }
}

function learnCompanyPrograms(
  company: WatchCompany,
  interventions: NonNullable<NonNullable<ClinicalStudy["protocolSection"]>["armsInterventionsModule"]>["interventions"] = [],
): void {
  const eligibleTypes = new Set(["DRUG", "BIOLOGICAL", "GENETIC"]);
  const existing = new Set(company.programs.map((program) => program.toLowerCase()));
  for (const intervention of interventions ?? []) {
    if (intervention.type && !eligibleTypes.has(intervention.type.toUpperCase())) continue;
    for (const raw of [intervention.name, ...(intervention.otherNames ?? [])]) {
      const program = raw?.trim() ?? "";
      if (!program || program.length < 3 || program.length > 80) continue;
      if (/^(?:placebo|standard of care|best supportive care|no intervention)$/i.test(program)) continue;
      if (existing.has(program.toLowerCase())) continue;
      company.programs.push(program);
      existing.add(program.toLowerCase());
      if (company.programs.length >= 250) return;
    }
  }
}

interface ClinicalBatchResult {
  studies: ClinicalStudy[];
  totalCount: number;
  truncated: boolean;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}
