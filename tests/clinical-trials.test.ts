import { afterEach, describe, expect, it, vi } from "vitest";
import { ClinicalTrialsSource } from "../src/sources/clinical-trials.js";
import type { WatchCompany } from "../src/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ClinicalTrialsSource calendar sync", () => {
  it("performs a full active-study sync and searches sponsor aliases", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T15:00:00.000Z"));
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json({
      totalCount: 1,
      studies: [{
        protocolSection: {
          identificationModule: {
            nctId: "NCT01234567",
            briefTitle: "mRNA-4157 pivotal study",
            organization: { fullName: "ModernaTX, Inc." },
          },
          statusModule: {
            overallStatus: "RECRUITING",
            lastUpdatePostDateStruct: { date: "2026-07-01" },
            primaryCompletionDateStruct: { date: "2027-12", type: "ESTIMATED" },
          },
          sponsorCollaboratorsModule: { leadSponsor: { name: "ModernaTX, Inc." } },
          designModule: { phases: ["PHASE3"], enrollmentInfo: { count: 500 } },
          conditionsModule: { conditions: ["Melanoma"] },
          armsInterventionsModule: { interventions: [{ type: "BIOLOGICAL", name: "mRNA-4157" }] },
        },
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const watchlist: WatchCompany[] = [{
      ticker: "MRNA",
      company: "Moderna",
      aliases: ["Moderna, Inc.", "ModernaTX", "ModernaTX, Inc."],
      cik: "1682852",
      marketCapBand: "large",
      xAccounts: [],
      programs: [],
    }];
    const source = new ClinicalTrialsSource(watchlist, 5_000);

    const result = await source.fetch(null);
    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));

    expect(requestedUrl.searchParams.get("query.spons")).toContain("ModernaTX");
    expect(requestedUrl.searchParams.get("filter.overallStatus")).toContain("RECRUITING");
    expect(requestedUrl.searchParams.get("fields")).toContain("PrimaryCompletionDate");
    expect(requestedUrl.searchParams.get("fields")).not.toContain("DetailedDescription");
    expect(requestedUrl.searchParams.has("filter.advanced")).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      tickerHint: "MRNA",
      companyHint: "Moderna",
      raw: { catalystWatch: { syncMode: "full", calendarOnly: true } },
    });
    expect(JSON.parse(result.cursor!)).toMatchObject({
      mode: "incremental",
      nextCompanyIndex: 1,
      since: "2026-08-27",
    });
  });

  it("omits active studies whose registered primary completion is already past", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T15:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      totalCount: 1,
      studies: [{
        protocolSection: {
          identificationModule: { nctId: "NCT00000001", briefTitle: "Legacy study" },
          statusModule: {
            overallStatus: "ACTIVE_NOT_RECRUITING",
            lastUpdatePostDateStruct: { date: "2024-01-01" },
            primaryCompletionDateStruct: { date: "2025-12", type: "ESTIMATED" },
          },
          sponsorCollaboratorsModule: { leadSponsor: { name: "Moderna" } },
        },
      }],
    })));
    const source = new ClinicalTrialsSource([{
      ticker: "MRNA",
      company: "Moderna",
      aliases: [],
      cik: "1682852",
      marketCapBand: "large",
      xAccounts: [],
      programs: [],
    }], 5_000);

    const result = await source.fetch(null);

    expect(result.items).toEqual([]);
    expect(JSON.parse(result.cursor!)).toMatchObject({ mode: "incremental", nextCompanyIndex: 1 });
  });

  it("keeps an academically sponsored study when a watchlist company is a collaborator", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      totalCount: 1,
      studies: [{
        protocolSection: {
          identificationModule: {
            nctId: "NCT07654321",
            briefTitle: "A pivotal vaccine study",
          },
          statusModule: {
            overallStatus: "RECRUITING",
            lastUpdatePostDateStruct: { date: "2026-08-20" },
            primaryCompletionDateStruct: { date: "2027-09", type: "ESTIMATED" },
          },
          sponsorCollaboratorsModule: {
            leadSponsor: { name: "University Medical Center" },
            collaborators: [{ name: "ModernaTX, Inc." }],
          },
          designModule: { phases: ["PHASE3"] },
          conditionsModule: { conditions: ["Respiratory infection"] },
          armsInterventionsModule: { interventions: [{ type: "BIOLOGICAL", name: "VAX-101" }] },
        },
      }],
    })));
    const source = new ClinicalTrialsSource([{
      ticker: "MRNA",
      company: "Moderna",
      aliases: ["ModernaTX"],
      cik: "1682852",
      marketCapBand: "large",
      xAccounts: [],
      programs: [],
    }], 5_000);

    const result = await source.fetch(null);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ tickerHint: "MRNA", companyHint: "Moderna" });
  });

  it("bounds a large initial backfill and persists the next company offset", async () => {
    const fetchMock = vi.fn(async () => Response.json({ totalCount: 0, studies: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const watchlist = Array.from({ length: 13 }, (_, index): WatchCompany => ({
      ticker: `T${index}`,
      company: `Example Therapeutics ${index}`,
      aliases: [],
      cik: String(1_000_000 + index),
      marketCapBand: "small",
      xAccounts: [],
      programs: [],
    }));
    const source = new ClinicalTrialsSource(watchlist, 5_000);

    const result = await source.fetch(null);
    const cursor = JSON.parse(result.cursor!);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.diagnostics).toMatchObject({
      syncMode: "full",
      companyStartIndex: 0,
      companyCount: 12,
      nextCompanyIndex: 12,
      totalCompanyCount: 13,
    });
    expect(cursor).toMatchObject({ mode: "backfill", nextCompanyIndex: 12 });
  });
});
