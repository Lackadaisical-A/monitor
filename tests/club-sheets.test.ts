import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildClubAttendanceMatrix, createClubAttendanceSheetSync } from "../src/club-sheets.js";
import type { SignalStore } from "../src/store.js";
import type { ClubAttendanceSnapshot } from "../src/types.js";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
});

describe("Google Sheets club attendance matrix", () => {
  it("puts attendees in rows and meetings in dated columns", () => {
    const matrix = buildClubAttendanceMatrix(snapshot(), "America/New_York");

    expect(matrix).toMatchObject({ memberCount: 2, meetingCount: 3 });
    expect(matrix.values).toEqual([
      [
        "ATTENDEE",
        "Jan 10, 2026\nKickoff",
        "Jan 17, 2026\nWorkshop",
        "Jan 24, 2026\nCurrent meeting",
      ],
      ["Alice", "PRESENT", "ABSENT", "PENDING"],
      ["Bob", "N/A", "PRESENT", "PRESENT"],
    ]);
  });

  it("exports no member, event, or card identifiers", () => {
    const output = JSON.stringify(buildClubAttendanceMatrix(snapshot(), "America/New_York").values);

    expect(output).not.toContain("member-alice");
    expect(output).not.toContain("meeting-kickoff");
    expect(output).not.toContain("04a1b2c3");
  });

  it("replaces and formats the configured sheet tab", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url === "https://oauth2.googleapis.com/token") {
        return jsonResponse({ access_token: "test-access-token", expires_in: 3600 });
      }
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse({
          sheets: [{
            properties: { sheetId: 0, title: "Sheet1", gridProperties: { rowCount: 1000, columnCount: 26 } },
            conditionalFormats: [{ booleanRule: {} }],
          }],
        });
      }
      return jsonResponse({});
    };
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sync = createClubAttendanceSheetSync(
      {
        spreadsheetId: "spreadsheet-id",
        sheetId: 0,
        sheetTitle: "Attendance",
        serviceAccountEmail: "attendance@example.iam.gserviceaccount.com",
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        timeZone: "America/New_York",
        syncIntervalSeconds: 300,
      },
      { getClubAttendanceSnapshot: () => snapshot() } as SignalStore,
      { info: () => {}, warn: () => {}, error: () => {} },
    );

    expect(sync).not.toBeNull();
    const status = await sync!.syncNow();

    expect(status).toMatchObject({ lastError: null, memberCount: 2, meetingCount: 3 });
    const valuesCall = calls.find(({ url, init }) => url.includes("valueInputOption=RAW") && init?.method === "PUT");
    expect(JSON.parse(String(valuesCall?.init?.body))).toMatchObject({
      values: [
        ["ATTENDEE", "Jan 10, 2026\nKickoff", "Jan 17, 2026\nWorkshop", "Jan 24, 2026\nCurrent meeting"],
        ["Alice", "PRESENT", "ABSENT", "PENDING"],
        ["Bob", "N/A", "PRESENT", "PRESENT"],
      ],
    });
    const batchBodies = calls
      .filter(({ url }) => url.endsWith(":batchUpdate"))
      .map(({ init }) => JSON.parse(String(init?.body)) as { requests: Array<Record<string, unknown>> });
    expect(batchBodies[0]?.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ deleteConditionalFormatRule: { sheetId: 0, index: 0 } }),
      expect.objectContaining({ updateSheetProperties: expect.any(Object) }),
    ]));
    expect(batchBodies[1]?.requests.filter((request) => "addConditionalFormatRule" in request)).toHaveLength(4);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function snapshot(): ClubAttendanceSnapshot {
  return {
    members: [
      { id: "member-bob", name: "Bob", createdAt: "2026-01-12T15:00:00.000Z" },
      { id: "member-alice", name: "Alice", createdAt: "2026-01-01T15:00:00.000Z" },
    ],
    meetings: [
      {
        id: "meeting-workshop",
        title: "Workshop",
        startedAt: "2026-01-17T15:00:00.000Z",
        endedAt: "2026-01-17T17:00:00.000Z",
      },
      {
        id: "meeting-current",
        title: "Current meeting",
        startedAt: "2026-01-24T15:00:00.000Z",
        endedAt: null,
      },
      {
        id: "meeting-kickoff",
        title: "Kickoff",
        startedAt: "2026-01-10T15:00:00.000Z",
        endedAt: "2026-01-10T17:00:00.000Z",
      },
    ],
    checkIns: [
      { eventId: "meeting-kickoff", memberId: "member-alice" },
      { eventId: "meeting-workshop", memberId: "member-bob" },
      { eventId: "meeting-current", memberId: "member-bob" },
    ],
  };
}
