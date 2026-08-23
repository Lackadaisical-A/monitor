import type {
  AlertTier,
  AnalysisRecord,
  CatalystEventType,
  DeviceRegistration,
  FeedEntry,
  FeedMode,
  InstallationAccess,
  InstallationPreferences,
  NormalizedItem,
  PushMode,
  StoreTransactionEntitlement,
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

export interface AlertInput {
  id: string;
  itemId: string;
  ticker: string;
  eventType: string;
  tier: AlertTier;
  status: "sent" | "dry_run" | "failed" | "suppressed";
  deviceToken?: string | null;
  response?: unknown;
}

export interface SignalStore {
  close?(): Awaitable<void>;
  insertItem(item: NormalizedItem): Awaitable<boolean>;
  insertItems?(items: NormalizedItem[]): Awaitable<number>;
  saveAnalysis(record: AnalysisRecord): Awaitable<void>;
  markItem(itemId: string, status: "skipped" | "error"): Awaitable<void>;
  getItem(itemId: string): Awaitable<NormalizedItem | null>;
  getPendingItems(limit?: number): Awaitable<NormalizedItem[]>;
  findCorroboratingItems(item: NormalizedItem, sinceIso: string): Awaitable<NormalizedItem[]>;
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
  applyStoreTransaction(entitlement: StoreTransactionEntitlement): Awaitable<number>;
  getInstallationPreferences(installationId: string): Awaitable<InstallationPreferences>;
  updateInstallationPreferences(input: {
    installationId: string;
    watchedTickers: string[];
    feedMode: FeedMode;
    pushMode: PushMode;
    eventTypes: CatalystEventType[];
  }): Awaitable<InstallationPreferences>;
  upsertDevice(device: DeviceRegistration): Awaitable<void>;
  listDevices(): Awaitable<Array<DeviceRegistration & { active: boolean }>>;
  listAlertDevices(ticker?: string, eventType?: CatalystEventType): Awaitable<Array<DeviceRegistration & { active: boolean }>>;
  deactivateDevice(deviceToken: string): Awaitable<void>;
  hasRecentAlert(ticker: string, eventType: string, sinceIso: string): Awaitable<boolean>;
  saveAlert(input: AlertInput): Awaitable<void>;
  stats(): Awaitable<Record<string, number>>;
  tryAcquireScanLease?(leaseId: string, expiresAt: string): Awaitable<boolean>;
  releaseScanLease?(leaseId: string): Awaitable<void>;
}
