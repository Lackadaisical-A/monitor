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
      startDateStruct?: { date?: string; type?: string };
      primaryCompletionDateStruct?: { date?: string; type?: string };
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

const SPONSOR_BATCH_SIZE = 3;
const BATCH_CONCURRENCY = 3;
const MAX_PAGES_PER_BATCH = 25;
const ACTIVE_STATUSES = [
  "RECRUITING",
  "NOT_YET_RECRUITING",
  "ACTIVE_NOT_RECRUITING",
  "ENROLLING_BY_INVITATION",
];

export class ClinicalTrialsSource implements SourceAdapter {
  readonly descriptor = {
    id: "clinicaltrials-calendar-v2",
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
    const fullSync = cursor === null;
    const since = cursor && /^\d{4}-\d{2}-\d{2}$/.test(cursor)
      ? cursor
      : new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const batches = chunk(this.watchlist, SPONSOR_BATCH_SIZE);
    const batchResults = await mapWithConcurrency(
      batches,
      BATCH_CONCURRENCY,
      (batch) => this.fetchBatch(batch, since, fullSync),
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
      const collaborators = protocol?.sponsorCollaboratorsModule?.collaborators?.map((entry) => entry.name).filter(Boolean) ?? [];
      const phases = protocol?.designModule?.phases?.join("/") ?? "Unknown phase";
      const resultsDate = status?.resultsFirstPostDateStruct?.date;
      const isFreshResults = Boolean(resultsDate && resultsDate >= since);
      const lastUpdateDate = status?.lastUpdatePostDateStruct?.date;
      const isFreshUpdate = Boolean(lastUpdateDate && lastUpdateDate >= since);
      const headline = `ClinicalTrials.gov ${isFreshResults ? "results posted" : "record updated"}: ${title}`;
      const outcomes = protocol?.outcomesModule?.primaryOutcomes?.map((outcome) => `${outcome.measure ?? ""}: ${outcome.description ?? ""}`).join("\n") ?? "";
      const interventions = protocol?.armsInterventionsModule?.interventions ?? [];
      const interventionNames = interventions.flatMap((intervention) => [intervention.name, ...(intervention.otherNames ?? [])])
        .filter((value): value is string => Boolean(value));
      const summary = [
        `Sponsor: ${sponsor}`,
        collaborators.length ? `Collaborators: ${collaborators.join(", ")}` : "",
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
      const company = resolveClinicalCompany(study, title, summary, this.watchlist);
      if (!company) continue;
      learnCompanyPrograms(company, interventions);
      if (fullSync && !isFutureRegistryDate(status?.primaryCompletionDateStruct?.date, discoveredAt)) continue;
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
        raw: {
          ...(fullSync ? compactCalendarStudy(study) : study),
          catalystWatch: {
            syncMode: fullSync ? "full" : "incremental",
            calendarOnly: fullSync,
          },
        },
      } satisfies NormalizedItem;
      itemsById.set(item.id, item);
    }
    const items = [...itemsById.values()];
    const complete = successful.length === batchResults.length
      && successful.every((result) => !result.value.truncated);
    return {
      items,
      ...(complete ? { cursor: discoveredAt.slice(0, 10) } : cursor ? { cursor } : {}),
      diagnostics: {
        syncMode: fullSync ? "full" : "incremental",
        batchCount: batches.length,
        failedBatchCount: batchResults.length - successful.length,
        reportedStudyCount: successful.reduce((sum, result) => sum + result.value.totalCount, 0),
        truncatedBatchCount: successful.filter((result) => result.value.truncated).length,
        since,
      },
    };
  }

  private async fetchBatch(batch: WatchCompany[], since: string, fullSync: boolean): Promise<ClinicalBatchResult> {
    const sponsorQuery = sponsorTerms(batch).map((term) => `\"${term.replaceAll('"', "")}\"`).join(" OR ");
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
      if (fullSync) url.searchParams.set("filter.overallStatus", ACTIVE_STATUSES.join("|"));
      else url.searchParams.set("filter.advanced", `AREA[LastUpdatePostDate]RANGE[${since}, MAX]`);
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

function sponsorTerms(companies: readonly WatchCompany[]): string[] {
  const terms = new Map<string, string>();
  for (const company of companies) {
    for (const raw of [company.company, ...company.aliases]) {
      const value = raw.trim();
      if (!value || value.startsWith("$") || value.toUpperCase() === company.ticker || value.length < 3) continue;
      const key = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (key && !terms.has(key)) terms.set(key, value);
    }
  }
  return [...terms.values()];
}

function resolveClinicalCompany(
  study: ClinicalStudy,
  title: string,
  summary: string,
  watchlist: readonly WatchCompany[],
): WatchCompany | null {
  const sponsorModule = study.protocolSection?.sponsorCollaboratorsModule;
  const participantNames = [
    sponsorModule?.leadSponsor?.name,
    ...(sponsorModule?.collaborators?.map((entry) => entry.name) ?? []),
  ].filter((value): value is string => Boolean(value))
    .map(normalizedOrganization)
    .filter(Boolean);
  const directMatches = watchlist.filter((company) => (
    [company.company, ...company.aliases]
      .filter((value) => value && !value.startsWith("$") && value.toUpperCase() !== company.ticker)
      .map(normalizedOrganization)
      .some((name) => name && participantNames.includes(name))
  ));
  if (directMatches.length === 1) return directMatches[0]!;
  return resolveWatchCompany({
    headline: title,
    summary,
    companyHint: sponsorModule?.leadSponsor?.name ?? "",
  }, directMatches.length ? directMatches : [...watchlist]);
}

function normalizedOrganization(value: string): string {
  const suffixes = new Set([
    "adr", "ag", "co", "company", "corp", "corporation", "inc", "incorporated", "limited", "llc",
    "ltd", "nv", "plc", "sa", "se",
  ]);
  const tokens = value.toLowerCase().replace(/&/g, " and ").match(/[a-z0-9]+/g) ?? [];
  while (tokens.length && suffixes.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join("");
}

function compactCalendarStudy(study: ClinicalStudy): ClinicalStudy {
  const protocol = study.protocolSection;
  if (!protocol) return {};
  const compact: NonNullable<ClinicalStudy["protocolSection"]> = {};
  if (protocol.identificationModule) compact.identificationModule = protocol.identificationModule;
  if (protocol.statusModule) compact.statusModule = protocol.statusModule;
  if (protocol.sponsorCollaboratorsModule) compact.sponsorCollaboratorsModule = protocol.sponsorCollaboratorsModule;
  if (protocol.designModule) compact.designModule = protocol.designModule;
  if (protocol.conditionsModule) compact.conditionsModule = protocol.conditionsModule;
  if (protocol.armsInterventionsModule) compact.armsInterventionsModule = protocol.armsInterventionsModule;
  return { protocolSection: compact };
}

function isFutureRegistryDate(value: string | undefined, asOf: string): boolean {
  if (!value) return false;
  let timestamp = Number.NaN;
  const exact = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(value);
  const month = /^(20\d{2})-(\d{2})$/.exec(value);
  const year = /^(20\d{2})$/.exec(value);
  if (exact) timestamp = Date.UTC(Number(exact[1]), Number(exact[2]) - 1, Number(exact[3]), 12);
  else if (month) timestamp = Date.UTC(Number(month[1]), Number(month[2]), 0, 12);
  else if (year) timestamp = Date.UTC(Number(year[1]), 11, 31, 12);
  const reference = new Date(asOf);
  const startOfDay = Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate());
  return Number.isFinite(timestamp) && timestamp >= startOfDay;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}
