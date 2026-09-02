import { importPKCS8, SignJWT } from "jose";
import type { AppConfig } from "./config.js";
import type { PipelineLogger } from "./pipeline.js";
import type { Awaitable, SignalStore } from "./store.js";
import type { ClubAttendanceSnapshot } from "./types.js";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";

type ClubSheetsConfig = AppConfig["club"]["sheets"];
type AttendanceStatus = "PRESENT" | "ABSENT" | "PENDING" | "N/A";

export interface ClubAttendanceMatrix {
  values: string[][];
  memberCount: number;
  meetingCount: number;
}

export interface ClubSheetSyncStatus {
  configured: true;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  memberCount: number;
  meetingCount: number;
}

export interface ClubAttendanceSheetSync {
  requestSync(): void;
  syncNow(): Promise<ClubSheetSyncStatus>;
  getStatus(): ClubSheetSyncStatus;
}

export function createClubAttendanceSheetSync(
  config: ClubSheetsConfig,
  store: SignalStore,
  logger: PipelineLogger,
): ClubAttendanceSheetSync | null {
  if (!config.spreadsheetId
    || !config.serviceAccountEmail
    || !config.privateKey
    || !store.getClubAttendanceSnapshot) return null;
  return new GoogleClubAttendanceSheetSync(
    config,
    () => store.getClubAttendanceSnapshot!(),
    logger,
  );
}

export function buildClubAttendanceMatrix(
  snapshot: ClubAttendanceSnapshot,
  timeZone: string,
): ClubAttendanceMatrix {
  const meetings = [...snapshot.meetings].sort((left, right) => (
    left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id)
  ));
  const members = [...snapshot.members].sort((left, right) => (
    left.name.localeCompare(right.name, "en", { sensitivity: "base" }) || left.id.localeCompare(right.id)
  ));
  const checkIns = new Set(snapshot.checkIns.map(({ eventId, memberId }) => `${eventId}:${memberId}`));
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const values: string[][] = [[
    "ATTENDEE",
    ...meetings.map((meeting) => `${dateFormatter.format(new Date(meeting.startedAt))}\n${meeting.title}`),
  ]];

  for (const member of members) {
    values.push([
      member.name,
      ...meetings.map((meeting): AttendanceStatus => {
        if (checkIns.has(`${meeting.id}:${member.id}`)) return "PRESENT";
        if (!meeting.endedAt) return "PENDING";
        if (Date.parse(member.createdAt) > Date.parse(meeting.startedAt)) return "N/A";
        return "ABSENT";
      }),
    ]);
  }

  return { values, memberCount: members.length, meetingCount: meetings.length };
}

class GoogleClubAttendanceSheetSync implements ClubAttendanceSheetSync {
  private readonly client: GoogleSheetsClient;
  private dirty = false;
  private active: Promise<void> | null = null;
  private readonly status: ClubSheetSyncStatus = {
    configured: true,
    running: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    memberCount: 0,
    meetingCount: 0,
  };

  constructor(
    private readonly config: ClubSheetsConfig,
    private readonly snapshotProvider: () => Awaitable<ClubAttendanceSnapshot>,
    private readonly logger: PipelineLogger,
  ) {
    this.client = new GoogleSheetsClient(config);
  }

  requestSync(): void {
    this.dirty = true;
    if (this.active) return;
    this.active = this.drain().finally(() => {
      this.active = null;
      if (this.dirty) this.requestSync();
    });
  }

  async syncNow(): Promise<ClubSheetSyncStatus> {
    this.requestSync();
    if (this.active) await this.active;
    return this.getStatus();
  }

  getStatus(): ClubSheetSyncStatus {
    return { ...this.status };
  }

  private async drain(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try {
        await this.syncOnce();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.status.lastError = message;
        this.logger.warn({ error: message }, "Google Sheets attendance sync failed");
        return;
      }
    }
  }

  private async syncOnce(): Promise<void> {
    this.status.running = true;
    this.status.lastAttemptAt = new Date().toISOString();
    try {
      const snapshot = await this.snapshotProvider();
      const matrix = buildClubAttendanceMatrix(snapshot, this.config.timeZone);
      await this.client.replaceAttendanceMatrix(matrix);
      this.status.lastSuccessAt = new Date().toISOString();
      this.status.lastError = null;
      this.status.memberCount = matrix.memberCount;
      this.status.meetingCount = matrix.meetingCount;
      this.logger.info(
        { memberCount: matrix.memberCount, meetingCount: matrix.meetingCount },
        "Google Sheets attendance sync completed",
      );
    } finally {
      this.status.running = false;
    }
  }
}

interface GoogleSpreadsheet {
  sheets?: Array<{
    properties: {
      sheetId: number;
      title: string;
      gridProperties?: { rowCount?: number; columnCount?: number };
    };
    conditionalFormats?: unknown[];
  }>;
}

class GoogleSheetsClient {
  private accessToken = "";
  private accessTokenExpiresAt = 0;
  private signingKey: ReturnType<typeof importPKCS8> | null = null;

  constructor(private readonly config: ClubSheetsConfig) {}

  async replaceAttendanceMatrix(matrix: ClubAttendanceMatrix): Promise<void> {
    const spreadsheet = await this.request<GoogleSpreadsheet>(
      `/spreadsheets/${encodeURIComponent(this.config.spreadsheetId)}`
      + `?includeGridData=false&fields=${encodeURIComponent("sheets(properties(sheetId,title,gridProperties),conditionalFormats)")}`,
    );
    const sheet = spreadsheet.sheets?.find(({ properties }) => properties.sheetId === this.config.sheetId);
    if (!sheet) throw new Error(`Google Sheet tab ID ${this.config.sheetId} was not found`);

    const rowCount = Math.max(sheet.properties.gridProperties?.rowCount ?? 0, matrix.values.length + 10, 100);
    const columnCount = Math.max(sheet.properties.gridProperties?.columnCount ?? 0, matrix.values[0]?.length ?? 1, 26);
    const preparationRequests: Record<string, unknown>[] = [];
    for (let index = (sheet.conditionalFormats?.length ?? 0) - 1; index >= 0; index -= 1) {
      preparationRequests.push({ deleteConditionalFormatRule: { sheetId: this.config.sheetId, index } });
    }
    preparationRequests.push(
      {
        updateSheetProperties: {
          properties: {
            sheetId: this.config.sheetId,
            title: this.config.sheetTitle,
            gridProperties: {
              rowCount,
              columnCount,
              frozenRowCount: 1,
              frozenColumnCount: 1,
            },
          },
          fields: "title,gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
        },
      },
      {
        repeatCell: {
          range: { sheetId: this.config.sheetId },
          cell: { userEnteredFormat: {} },
          fields: "userEnteredFormat",
        },
      },
    );
    await this.batchUpdate(preparationRequests);

    const sheetRange = quoteSheetName(this.config.sheetTitle);
    await this.request(
      `/spreadsheets/${encodeURIComponent(this.config.spreadsheetId)}/values/${encodeURIComponent(sheetRange)}:clear`,
      { method: "POST", body: "{}" },
    );
    const usedRange = `${sheetRange}!A1:${a1Column(matrix.values[0]?.length ?? 1)}${matrix.values.length}`;
    await this.request(
      `/spreadsheets/${encodeURIComponent(this.config.spreadsheetId)}/values/${encodeURIComponent(usedRange)}?valueInputOption=RAW`,
      {
        method: "PUT",
        body: JSON.stringify({ range: usedRange, majorDimension: "ROWS", values: matrix.values }),
      },
    );
    await this.batchUpdate(formatRequests(this.config.sheetId, matrix.values.length, matrix.values[0]?.length ?? 1));
  }

  private async batchUpdate(requests: Record<string, unknown>[]): Promise<void> {
    await this.request(`/spreadsheets/${encodeURIComponent(this.config.spreadsheetId)}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests }),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await this.token()}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(`${SHEETS_API_BASE}${path}`, { ...init, headers });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as { error?: { message?: string } } : null;
    if (!response.ok) {
      throw new Error(`Google Sheets API ${response.status}: ${payload?.error?.message ?? response.statusText}`);
    }
    return payload as T;
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken;
    this.signingKey ??= importPKCS8(this.config.privateKey, "RS256");
    const assertion = await new SignJWT({ scope: SHEETS_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.config.serviceAccountEmail)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(await this.signingKey);
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    const payload = await response.json() as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!response.ok || !payload.access_token) {
      throw new Error(`Google OAuth ${response.status}: ${payload.error_description ?? response.statusText}`);
    }
    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = Date.now() + (payload.expires_in ?? 3_600) * 1_000;
    return this.accessToken;
  }
}

function formatRequests(sheetId: number, rowCount: number, columnCount: number): Record<string, unknown>[] {
  const usedRange = { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount };
  const requests: Record<string, unknown>[] = [
    {
      repeatCell: {
        range: usedRange,
        cell: {
          userEnteredFormat: {
            backgroundColor: color("FFFFFF"),
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            wrapStrategy: "WRAP",
            textFormat: { foregroundColor: color("202124"), fontSize: 10 },
            borders: {
              top: border(), bottom: border(), left: border(), right: border(),
            },
          },
        },
        fields: "userEnteredFormat",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
        cell: {
          userEnteredFormat: {
            backgroundColor: color("202124"),
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            wrapStrategy: "WRAP",
            textFormat: { foregroundColor: color("FFFFFF"), bold: true, fontSize: 10 },
            borders: {
              top: border("FFFFFF"), bottom: border("FFFFFF"), left: border("FFFFFF"), right: border("FFFFFF"),
            },
          },
        },
        fields: "userEnteredFormat",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 220 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 58 },
        fields: "pixelSize",
      },
    },
  ];

  if (rowCount > 1) {
    requests.push(
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: color("F1F3F4"),
              horizontalAlignment: "LEFT",
              verticalAlignment: "MIDDLE",
              textFormat: { foregroundColor: color("202124"), bold: true, fontSize: 10 },
              borders: {
                top: border(), bottom: border(), left: border(), right: border(),
              },
            },
          },
          fields: "userEnteredFormat",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: rowCount },
          properties: { pixelSize: 34 },
          fields: "pixelSize",
        },
      },
    );
  }
  if (columnCount > 1) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: columnCount },
        properties: { pixelSize: 140 },
        fields: "pixelSize",
      },
    });
  }
  if (rowCount > 1 && columnCount > 1) {
    const statusRange = { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 1, endColumnIndex: columnCount };
    requests.push(
      conditionalFormat(statusRange, "PRESENT", "34A853"),
      conditionalFormat(statusRange, "ABSENT", "EA4335"),
      conditionalFormat(statusRange, "PENDING", "202124"),
      conditionalFormat(statusRange, "N/A", "202124"),
    );
  }
  return requests;
}

function conditionalFormat(range: Record<string, number>, value: AttendanceStatus, hex: string) {
  return {
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [range],
        booleanRule: {
          condition: { type: "TEXT_EQ", values: [{ userEnteredValue: value }] },
          format: {
            backgroundColor: color(hex),
            textFormat: { foregroundColor: color("FFFFFF"), bold: true },
          },
        },
      },
    },
  };
}

function border(hex = "DADCE0") {
  return { style: "SOLID", color: color(hex) };
}

function color(hex: string) {
  return {
    red: Number.parseInt(hex.slice(0, 2), 16) / 255,
    green: Number.parseInt(hex.slice(2, 4), 16) / 255,
    blue: Number.parseInt(hex.slice(4, 6), 16) / 255,
  };
}

function quoteSheetName(title: string): string {
  return `'${title.replaceAll("'", "''")}'`;
}

function a1Column(columnCount: number): string {
  let value = columnCount;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result || "A";
}
