import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { SourceTier, SourceType, WatchCompany } from "./types.js";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_PATH: z.string().default("./data/biotech-signal.db"),
  SCAN_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(60),
  SOURCE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DASHBOARD_TOKEN: z.string().default(""),
  DEVICE_PAIRING_TOKEN: z.string().default(""),
  DEVELOPER_PAIRING_TOKEN: z.string().default(""),
  FREE_FEED_DELAY_MINUTES: z.coerce.number().int().min(5).max(1_440).default(30),
  APP_STORE_BUNDLE_ID: z.string().default("com.yingcui.CatalystWatch"),
  APP_STORE_APP_ID: z.coerce.number().int().positive().default(6803988538),
  APP_STORE_PRODUCT_IDS: z.string().default("com.yingcui.CatalystWatch.pro.monthly,com.yingcui.CatalystWatch.pro.yearly"),
  APPLE_ROOT_CA_DIR: z.string().default("./config/apple"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-5.6-luna"),
  ALPACA_MARKET_DATA_SCOPE: z.enum(["disabled", "developer", "all"]).default("disabled"),
  ALPACA_API_KEY_ID: z.string().default(""),
  ALPACA_API_SECRET_KEY: z.string().default(""),
  ALPACA_DATA_FEED: z.enum(["iex", "sip"]).default("iex"),
  ALPACA_NEWS_ENABLED: booleanEnv(true),
  SOURCES_FILE: z.string().default("./config/sources.json"),
  WATCHLIST_FILE: z.string().default("./config/watchlist.json"),
  X_BEARER_TOKEN: z.string().default(""),
  X_QUERY: z.string().default('(\"Phase 2\" OR \"Phase 3\" OR topline OR \"primary endpoint\" OR FDA) (biotech OR pharma) -is:retweet -is:reply lang:en'),
  REDDIT_CLIENT_ID: z.string().default(""),
  REDDIT_CLIENT_SECRET: z.string().default(""),
  REDDIT_USER_AGENT: z.string().default("BiotechSignal/0.1"),
  REDDIT_SUBREDDITS: z.string().default("biotech+Biotechplays"),
  CLINICAL_TRIALS_ENABLED: booleanEnv(true),
  SEC_ENABLED: booleanEnv(true),
  FDA_ADCOM_ENABLED: booleanEnv(true),
  SEC_USER_AGENT: z.string().default("BiotechSignal/0.1 contact@example.com"),
  ALERT_DRY_RUN: booleanEnv(true),
  ALERT_HIGH_MIN_MATERIALITY: z.coerce.number().int().min(0).max(100).default(70),
  ALERT_HIGH_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  ALERT_MIN_MATERIALITY: z.coerce.number().int().min(0).max(100).default(88),
  ALERT_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.86),
  ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(1).default(240),
  ALERT_MAX_AGE_MINUTES: z.coerce.number().int().min(1).max(1_440).default(30),
  ANALYSIS_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  ANALYSIS_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  ANALYSIS_HISTORY_DAYS: z.coerce.number().int().min(1).max(730).default(180),
  DISCOVERY_SLO_SECONDS: z.coerce.number().int().min(15).default(120),
  ANALYSIS_SLO_SECONDS: z.coerce.number().int().min(5).default(45),
  PUSH_SLO_SECONDS: z.coerce.number().int().min(15).default(180),
  OUTCOME_AUDIT_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(15),
  OUTCOME_AUDIT_BATCH_SIZE: z.coerce.number().int().min(1).max(250).default(30),
  APNS_TEAM_ID: z.string().default(""),
  APNS_KEY_ID: z.string().default(""),
  APNS_BUNDLE_ID: z.string().default("com.yingcui.CatalystWatch"),
  APNS_PRIVATE_KEY: z.string().default(""),
  APNS_PRIVATE_KEY_PATH: z.string().default(""),
  APNS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  APNS_ALLOW_CRITICAL: booleanEnv(false),
});

const WatchCompanySchema = z.object({
  ticker: z.string().min(1).transform((value) => value.toUpperCase()),
  company: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  cik: z.string().regex(/^\d{1,10}$/).optional(),
  marketCapBand: z.enum(["micro", "small", "mid", "large", "mega", "unknown"]).default("unknown"),
  marketCapUsd: z.number().positive().optional(),
  averageDailyDollarVolume: z.number().nonnegative().optional(),
  annualizedVolatilityPct: z.number().nonnegative().optional(),
  metadataUpdatedAt: z.string().datetime().optional(),
  xAccounts: z.array(z.string()).default([]),
  programs: z.array(z.string()).default([]),
});

const RssSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.literal("rss"),
  sourceType: z.enum(["company_ir", "regulator", "outlet"]).default("outlet"),
  tier: z.enum(["primary", "secondary"]).default("secondary"),
  url: z.string().url(),
  tickers: z.array(z.string().min(1).transform((value) => value.toUpperCase())).default([]),
  enabled: z.boolean().default(true),
});

const QuoteMediaSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.literal("quote_media"),
  sourceType: z.enum(["company_ir", "outlet"]).default("outlet"),
  tier: z.enum(["primary", "secondary"]).default("secondary"),
  symbol: z.string().min(1).transform((value) => value.toUpperCase()).optional(),
  symbols: z.array(z.string().min(1).transform((value) => value.toUpperCase())).max(500).default([]),
  watchlist: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

const ConfiguredSourceSchema = z.discriminatedUnion("type", [RssSourceSchema, QuoteMediaSourceSchema]);

export interface RssSourceConfig {
  id: string;
  name: string;
  type: "rss";
  sourceType: Extract<SourceType, "company_ir" | "regulator" | "outlet">;
  tier: Extract<SourceTier, "primary" | "secondary">;
  url: string;
  tickers: string[];
  enabled: boolean;
}

export interface QuoteMediaSourceConfig {
  id: string;
  name: string;
  type: "quote_media";
  sourceType: Extract<SourceType, "company_ir" | "outlet">;
  tier: Extract<SourceTier, "primary" | "secondary">;
  symbol?: string | undefined;
  symbols: string[];
  watchlist: boolean;
  enabled: boolean;
}

export interface AppConfig {
  port: number;
  host: string;
  databasePath: string;
  scanIntervalSeconds: number;
  sourceTimeoutMs: number;
  logLevel: string;
  dashboardToken: string;
  devicePairingToken: string;
  entitlements: {
    developerPairingToken: string;
    freeFeedDelayMinutes: number;
    bundleId: string;
    appAppleId: number;
    productIds: string[];
    appleRootCaDirectory: string;
  };
  openaiApiKey: string;
  openaiModel: string;
  alpaca: {
    scope: "disabled" | "developer" | "all";
    keyId: string;
    secretKey: string;
    feed: "iex" | "sip";
    newsEnabled: boolean;
  };
  watchlist: WatchCompany[];
  rssSources: RssSourceConfig[];
  quoteMediaSources: QuoteMediaSourceConfig[];
  x: { bearerToken: string; query: string };
  reddit: { clientId: string; clientSecret: string; userAgent: string; subreddits: string };
  clinicalTrialsEnabled: boolean;
  secEnabled: boolean;
  fdaAdcomEnabled: boolean;
  secUserAgent: string;
  alertPolicy: {
    dryRun: boolean;
    highMinMateriality: number;
    highMinConfidence: number;
    minMateriality: number;
    minConfidence: number;
    cooldownMinutes: number;
    maxAgeMinutes: number;
  };
  analysis: {
    concurrency: number;
    batchSize: number;
    historyDays: number;
  };
  slo: {
    discoverySeconds: number;
    analysisSeconds: number;
    pushSeconds: number;
  };
  outcomes: {
    intervalMinutes: number;
    batchSize: number;
  };
  apns: {
    teamId: string;
    keyId: string;
    bundleId: string;
    privateKey: string;
    privateKeyPath: string;
    environment: "sandbox" | "production";
    allowCritical: boolean;
  };
}

export function loadConfig(envInput: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = EnvSchema.parse(envInput);
  const watchlist = loadJsonFile(env.WATCHLIST_FILE, z.array(WatchCompanySchema), []);
  const configuredSources = loadJsonFile(env.SOURCES_FILE, z.array(ConfiguredSourceSchema), []).filter((source) => source.enabled);
  const rssSources = configuredSources.filter((source): source is RssSourceConfig => source.type === "rss");
  const quoteMediaSources = configuredSources.filter((source): source is QuoteMediaSourceConfig => source.type === "quote_media");
  return {
    port: env.PORT,
    host: env.HOST,
    databasePath: resolve(env.DATABASE_PATH),
    scanIntervalSeconds: env.SCAN_INTERVAL_SECONDS,
    sourceTimeoutMs: env.SOURCE_TIMEOUT_MS,
    logLevel: env.LOG_LEVEL,
    dashboardToken: env.DASHBOARD_TOKEN,
    devicePairingToken: env.DEVICE_PAIRING_TOKEN,
    entitlements: {
      developerPairingToken: env.DEVELOPER_PAIRING_TOKEN || env.DEVICE_PAIRING_TOKEN,
      freeFeedDelayMinutes: env.FREE_FEED_DELAY_MINUTES,
      bundleId: env.APP_STORE_BUNDLE_ID,
      appAppleId: env.APP_STORE_APP_ID,
      productIds: env.APP_STORE_PRODUCT_IDS.split(",").map((value) => value.trim()).filter(Boolean),
      appleRootCaDirectory: resolve(env.APPLE_ROOT_CA_DIR),
    },
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL,
    alpaca: {
      scope: env.ALPACA_MARKET_DATA_SCOPE,
      keyId: env.ALPACA_API_KEY_ID.trim(),
      secretKey: env.ALPACA_API_SECRET_KEY.trim(),
      feed: env.ALPACA_DATA_FEED,
      newsEnabled: env.ALPACA_NEWS_ENABLED,
    },
    watchlist,
    rssSources,
    quoteMediaSources,
    x: { bearerToken: env.X_BEARER_TOKEN, query: env.X_QUERY },
    reddit: {
      clientId: env.REDDIT_CLIENT_ID,
      clientSecret: env.REDDIT_CLIENT_SECRET,
      userAgent: env.REDDIT_USER_AGENT,
      subreddits: env.REDDIT_SUBREDDITS,
    },
    clinicalTrialsEnabled: env.CLINICAL_TRIALS_ENABLED,
    secEnabled: env.SEC_ENABLED,
    fdaAdcomEnabled: env.FDA_ADCOM_ENABLED,
    secUserAgent: env.SEC_USER_AGENT,
    alertPolicy: {
      dryRun: env.ALERT_DRY_RUN,
      highMinMateriality: env.ALERT_HIGH_MIN_MATERIALITY,
      highMinConfidence: env.ALERT_HIGH_MIN_CONFIDENCE,
      minMateriality: env.ALERT_MIN_MATERIALITY,
      minConfidence: env.ALERT_MIN_CONFIDENCE,
      cooldownMinutes: env.ALERT_COOLDOWN_MINUTES,
      maxAgeMinutes: env.ALERT_MAX_AGE_MINUTES,
    },
    analysis: {
      concurrency: env.ANALYSIS_CONCURRENCY,
      batchSize: env.ANALYSIS_BATCH_SIZE,
      historyDays: env.ANALYSIS_HISTORY_DAYS,
    },
    slo: {
      discoverySeconds: env.DISCOVERY_SLO_SECONDS,
      analysisSeconds: env.ANALYSIS_SLO_SECONDS,
      pushSeconds: env.PUSH_SLO_SECONDS,
    },
    outcomes: {
      intervalMinutes: env.OUTCOME_AUDIT_INTERVAL_MINUTES,
      batchSize: env.OUTCOME_AUDIT_BATCH_SIZE,
    },
    apns: {
      teamId: env.APNS_TEAM_ID,
      keyId: env.APNS_KEY_ID,
      bundleId: env.APNS_BUNDLE_ID,
      privateKey: env.APNS_PRIVATE_KEY.replace(/\\n/g, "\n"),
      privateKeyPath: env.APNS_PRIVATE_KEY_PATH ? resolve(env.APNS_PRIVATE_KEY_PATH) : "",
      environment: env.APNS_ENVIRONMENT,
      allowCritical: env.APNS_ALLOW_CRITICAL,
    },
  };
}

function booleanEnv(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value, ctx) => {
      if (typeof value === "boolean") return value;
      if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
      if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
      ctx.addIssue({ code: "custom", message: `Expected a boolean, received ${value}` });
      return z.NEVER;
    });
}

function loadJsonFile<T>(path: string, schema: z.ZodType<T>, fallback: T): T {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return fallback;
  return schema.parse(JSON.parse(readFileSync(absolute, "utf8")));
}
