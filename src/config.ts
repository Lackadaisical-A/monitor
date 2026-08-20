import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { SourceTier, SourceType, WatchCompany } from "./types.js";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_PATH: z.string().default("./data/biotech-signal.db"),
  SCAN_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(120),
  SOURCE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DASHBOARD_TOKEN: z.string().default(""),
  DEVICE_PAIRING_TOKEN: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-5.4-mini"),
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
  SEC_USER_AGENT: z.string().default("BiotechSignal/0.1 contact@example.com"),
  ALERT_DRY_RUN: booleanEnv(true),
  ALERT_MIN_MATERIALITY: z.coerce.number().int().min(0).max(100).default(88),
  ALERT_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.86),
  ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(1).default(240),
  APNS_TEAM_ID: z.string().default(""),
  APNS_KEY_ID: z.string().default(""),
  APNS_BUNDLE_ID: z.string().default("com.example.BiotechSignal"),
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
  xAccounts: z.array(z.string()).default([]),
  programs: z.array(z.string()).default([]),
});

const RssSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.literal("rss"),
  sourceType: z.enum(["company_ir", "outlet"]).default("outlet"),
  tier: z.enum(["primary", "secondary"]).default("secondary"),
  url: z.string().url(),
  enabled: z.boolean().default(true),
});

export interface RssSourceConfig {
  id: string;
  name: string;
  type: "rss";
  sourceType: Extract<SourceType, "company_ir" | "outlet">;
  tier: Extract<SourceTier, "primary" | "secondary">;
  url: string;
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
  openaiApiKey: string;
  openaiModel: string;
  watchlist: WatchCompany[];
  rssSources: RssSourceConfig[];
  x: { bearerToken: string; query: string };
  reddit: { clientId: string; clientSecret: string; userAgent: string; subreddits: string };
  clinicalTrialsEnabled: boolean;
  secEnabled: boolean;
  secUserAgent: string;
  alertPolicy: {
    dryRun: boolean;
    minMateriality: number;
    minConfidence: number;
    cooldownMinutes: number;
  };
  apns: {
    teamId: string;
    keyId: string;
    bundleId: string;
    privateKeyPath: string;
    environment: "sandbox" | "production";
    allowCritical: boolean;
  };
}

export function loadConfig(envInput: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = EnvSchema.parse(envInput);
  const watchlist = loadJsonFile(env.WATCHLIST_FILE, z.array(WatchCompanySchema), []);
  const rssSources = loadJsonFile(env.SOURCES_FILE, z.array(RssSourceSchema), []).filter((source) => source.enabled);
  return {
    port: env.PORT,
    host: env.HOST,
    databasePath: resolve(env.DATABASE_PATH),
    scanIntervalSeconds: env.SCAN_INTERVAL_SECONDS,
    sourceTimeoutMs: env.SOURCE_TIMEOUT_MS,
    logLevel: env.LOG_LEVEL,
    dashboardToken: env.DASHBOARD_TOKEN,
    devicePairingToken: env.DEVICE_PAIRING_TOKEN,
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL,
    watchlist,
    rssSources,
    x: { bearerToken: env.X_BEARER_TOKEN, query: env.X_QUERY },
    reddit: {
      clientId: env.REDDIT_CLIENT_ID,
      clientSecret: env.REDDIT_CLIENT_SECRET,
      userAgent: env.REDDIT_USER_AGENT,
      subreddits: env.REDDIT_SUBREDDITS,
    },
    clinicalTrialsEnabled: env.CLINICAL_TRIALS_ENABLED,
    secEnabled: env.SEC_ENABLED,
    secUserAgent: env.SEC_USER_AGENT,
    alertPolicy: {
      dryRun: env.ALERT_DRY_RUN,
      minMateriality: env.ALERT_MIN_MATERIALITY,
      minConfidence: env.ALERT_MIN_CONFIDENCE,
      cooldownMinutes: env.ALERT_COOLDOWN_MINUTES,
    },
    apns: {
      teamId: env.APNS_TEAM_ID,
      keyId: env.APNS_KEY_ID,
      bundleId: env.APNS_BUNDLE_ID,
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
