import type {
  AlertTier,
  AlertPriority,
  AnalysisRecord,
  CatalystEventType,
  ClubCardCheckInInput,
  ClubCardCheckInResult,
  ClubAttendanceSnapshot,
  ClubDashboard,
  ClubEvent,
  ClubEventDetail,
  DeviceRegistration,
  FeedEntry,
  FeedMode,
  InstallationAccess,
  InstallationPreferences,
  NormalizedItem,
  OutcomeAudit,
  PushMode,
  SourceDescriptor,
  StoreTransactionEntitlement,
  TimelineEvent,
} from "./types.js";

export type Awaitable<T> = T | Promise<T>;

export interface SourceStateRecord {
  sourceId: string;
  cursor: string | null;
  lastFetchedAt: string | null;
  lastError: string | null;
}

export interface SourceStateUpdate {
  sourceId: string;
  cursor: string | null;
  error: string | null;
  fetchedAt: string;
}

export interface ItemFailureResult {
  attemptCount: number;
  retryScheduled: boolean;
  nextAttemptAt: string | null;
}

export interface AlertInput {
  id: string;
  itemId: string;
  ticker: string;
  eventType: string;
  tier: AlertTier;
  eventKey: string;
  status: "claimed" | "sent" | "dry_run" | "failed" | "suppressed";
  deviceToken?: string | null;
  response?: unknown;
}

export interface SignalStore {
  close?(): Awaitable<void>;
  insertItem(item: NormalizedItem): Awaitable<boolean>;
  insertItems?(items: NormalizedItem[]): Awaitable<number>;
  syncSourceDescriptors?(sources: readonly SourceDescriptor[]): Awaitable<number>;
  saveCompanyPrograms?(ticker: string, programs: readonly string[]): Awaitable<number>;
  listCompanyPrograms?(): Awaitable<Array<{ ticker: string; program: string }>>;
  saveAnalysis(record: AnalysisRecord): Awaitable<void>;
  markItem(itemId: string, status: "skipped" | "error"): Awaitable<void>;
  recordItemFailure?(itemId: string, error: string, maxAttempts?: number): Awaitable<ItemFailureResult>;
  getItem(itemId: string): Awaitable<NormalizedItem | null>;
  getPendingItems(limit?: number): Awaitable<NormalizedItem[]>;
  findCorroboratingItems(item: NormalizedItem, sinceIso: string): Awaitable<NormalizedItem[]>;
  findPriorItems(item: NormalizedItem, sinceIso: string, limit?: number): Awaitable<NormalizedItem[]>;
  requeueFailedItems?(limit?: number): Awaitable<number>;
  requeueOutdatedAnalyses?(analysisVersion: number, sinceIso: string, limit?: number): Awaitable<number>;
  listOutcomeAuditCandidates?(limit?: number, auditedBefore?: string): Awaitable<FeedEntry[]>;
  saveOutcomeAudit?(audit: OutcomeAudit): Awaitable<void>;
  listOutcomeAudits?(limit?: number): Awaitable<OutcomeAudit[]>;
  upsertTimelineEvents?(events: readonly TimelineEvent[]): Awaitable<number>;
  listTimelineEvents?(
    limit?: number,
    status?: TimelineEvent["status"] | null,
    publishedBefore?: string | null,
    tickers?: readonly string[] | null,
  ): Awaitable<TimelineEvent[]>;
  listFeed(limit?: number, publishedBefore?: string | null, tickers?: readonly string[] | null): Awaitable<FeedEntry[]>;
  getAnalysis(itemId: string): Awaitable<AnalysisRecord | null>;
  getSourceCursor(sourceId: string): Awaitable<string | null>;
  getSourceCursors?(sourceIds: string[]): Awaitable<Map<string, string | null>>;
  saveSourceState(sourceId: string, cursor: string | null, error: string | null, fetchedAt?: string): Awaitable<void>;
  saveSourceStates?(updates: SourceStateUpdate[]): Awaitable<void>;
  listSourceState(): Awaitable<SourceStateRecord[]>;
  registerInstallation(installationId: string, clientTokenHash: string): Awaitable<boolean>;
  installationTokenMatches(installationId: string, clientTokenHash: string): Awaitable<boolean>;
  getInstallationAccess(installationId: string): Awaitable<InstallationAccess | null>;
  activateDeveloperAccess(installationId: string): Awaitable<void>;
  activateClubAccess(installationId: string): Awaitable<void>;
  createClubEvent?(title: string, installationId: string): Awaitable<ClubEventDetail>;
  closeClubEvent?(eventId: string): Awaitable<ClubEventDetail | null>;
  getClubEvent?(eventId: string): Awaitable<ClubEventDetail | null>;
  getActiveClubEvent?(): Awaitable<ClubEvent | null>;
  getClubDashboard?(limit?: number): Awaitable<ClubDashboard>;
  getClubAttendanceSnapshot?(): Awaitable<ClubAttendanceSnapshot>;
  checkInClubCard?(input: ClubCardCheckInInput): Awaitable<ClubCardCheckInResult>;
  deleteClubMember?(memberId: string): Awaitable<boolean>;
  applyStoreTransaction(entitlement: StoreTransactionEntitlement): Awaitable<number>;
  getInstallationPreferences(installationId: string): Awaitable<InstallationPreferences>;
  updateInstallationPreferences(input: {
    installationId: string;
    watchedTickers: string[];
    feedMode: FeedMode;
    pushMode: PushMode;
    minimumAlertTier?: AlertPriority;
    eventTypes: CatalystEventType[];
  }): Awaitable<InstallationPreferences>;
  upsertDevice(device: DeviceRegistration): Awaitable<void>;
  listDevices(): Awaitable<Array<DeviceRegistration & { active: boolean }>>;
  listAlertDevices(ticker?: string, eventType?: CatalystEventType, tier?: AlertTier): Awaitable<Array<DeviceRegistration & { active: boolean }>>;
  deactivateDevice(deviceToken: string): Awaitable<void>;
  hasRecentAlert(eventKey: string, tier: AlertTier, sinceIso: string): Awaitable<boolean>;
  tryClaimAlertEvent?(input: AlertInput, sinceIso: string): Awaitable<boolean>;
  saveAlert(input: AlertInput): Awaitable<void>;
  stats(): Awaitable<Record<string, number>>;
  tryAcquireScanLease?(leaseId: string, expiresAt: string): Awaitable<boolean>;
  releaseScanLease?(leaseId: string): Awaitable<void>;
}
