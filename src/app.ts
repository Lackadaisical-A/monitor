import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { AlpacaMarketDataService, type MarketDataProvider } from "./market-data/alpaca.js";
import type { MonitorPipeline } from "./pipeline.js";
import type { SignalStore } from "./store.js";
import { AppStoreSubscriptionVerifier, type SubscriptionVerifier } from "./subscriptions.js";
import {
  CatalystEventTypeSchema,
  FeedModeSchema,
  PushModeSchema,
  type CompanyCoverage,
  type FeedEntry,
  type InstallationAccess,
  type WatchCompany,
} from "./types.js";
import { safeEqual } from "./utils.js";

const InstallationSchema = z.object({
  installationId: z.string().uuid(),
  clientToken: z.string().regex(/^[a-fA-F0-9]{64}$/),
});

const DeviceSchema = z.object({
  installationId: z.string().uuid(),
  deviceToken: z.string().regex(/^[a-fA-F0-9]{64,200}$/),
  environment: z.enum(["sandbox", "production"]),
  timeSensitiveAuthorized: z.boolean(),
  criticalAuthorized: z.boolean(),
});

const SignedTransactionSchema = z.object({
  signedTransaction: z.string().min(100).max(50_000),
});

const DeveloperCredentialSchema = z.object({
  credential: z.string().min(32).max(512),
});

const NotificationSchema = z.object({
  signedPayload: z.string().min(100).max(250_000),
});

const PreferencesUpdateSchema = z.object({
  watchedTickers: z.array(z.string().trim().min(1).max(12)).max(500),
  feedMode: FeedModeSchema,
  pushMode: PushModeSchema,
  eventTypes: z.array(CatalystEventTypeSchema).min(1),
});

const FREE_WATCHLIST_LIMIT = 10;

export async function createApp(
  config: AppConfig,
  db: SignalStore,
  pipeline: MonitorPipeline,
  subscriptionVerifier: SubscriptionVerifier = new AppStoreSubscriptionVerifier(config.entitlements),
  marketDataProvider?: MarketDataProvider,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 300_000,
  });
  const publicPath = resolve("public");
  const marketData = marketDataProvider ?? new AlpacaMarketDataService(config.alpaca, {
    timeoutMs: Math.min(config.sourceTimeoutMs, 8_000),
    onError: (error) => app.log.warn({ err: error }, "Alpaca market data request failed"),
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });
  if (existsSync(publicPath)) {
    await app.register(fastifyStatic, { root: publicPath, prefix: "/" });
  }

  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

  app.post("/api/installations", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const installation = InstallationSchema.parse(request.body);
    const registered = await db.registerInstallation(installation.installationId, hashToken(installation.clientToken));
    if (!registered) throw httpError(401, "Installation credentials were not accepted");
    return reply.code(201).send(entitlementResponse(config, await db.getInstallationAccess(installation.installationId)));
  });

  app.get("/api/entitlements", async (request) => {
    const access = await requireClientAccess(request, db);
    return entitlementResponse(config, access);
  });

  app.get("/api/preferences", async (request) => {
    const access = await requireClientAccess(request, db);
    return preferencesResponse(config, access, await db.getInstallationPreferences(access.installationId));
  });

  app.put("/api/preferences", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request) => {
    const access = await requireClientAccess(request, db);
    const body = PreferencesUpdateSchema.parse(request.body);
    const knownTickers = new Set(config.watchlist.map((company) => company.ticker));
    const watchedTickers = [...new Set(body.watchedTickers.map((ticker) => ticker.toUpperCase()))];
    const unknownTickers = watchedTickers.filter((ticker) => !knownTickers.has(ticker));
    if (unknownTickers.length) throw httpError(400, `Unknown watchlist ticker: ${unknownTickers[0]}`);
    const limit = watchlistLimit(config, access);
    if (watchedTickers.length > limit) {
      throw httpError(access.pro ? 400 : 403, access.pro
        ? `Watchlists are limited to ${limit} companies`
        : `Free watchlists are limited to ${limit} companies; Catalyst Watch Pro unlocks the full universe`);
    }
    const preferences = await db.updateInstallationPreferences({
      installationId: access.installationId,
      watchedTickers,
      feedMode: body.feedMode,
      pushMode: body.pushMode,
      eventTypes: body.eventTypes,
    });
    return preferencesResponse(config, access, preferences);
  });

  app.post("/api/entitlements/storekit", async (request) => {
    const access = await requireClientAccess(request, db);
    const body = SignedTransactionSchema.parse(request.body);
    const entitlement = await subscriptionVerifier.verifyTransaction(body.signedTransaction, access.installationId);
    await db.applyStoreTransaction(entitlement);
    return entitlementResponse(config, await db.getInstallationAccess(access.installationId));
  });

  app.post("/api/entitlements/developer", async (request) => {
    const access = await requireClientAccess(request, db);
    const body = DeveloperCredentialSchema.parse(request.body);
    if (!config.entitlements.developerPairingToken
      || !safeEqual(body.credential, config.entitlements.developerPairingToken)) {
      throw httpError(401, "Developer credential was not accepted");
    }
    await db.activateDeveloperAccess(access.installationId);
    return entitlementResponse(config, await db.getInstallationAccess(access.installationId));
  });

  app.post("/api/app-store/notifications", async (request) => {
    const body = NotificationSchema.parse(request.body);
    const notification = await subscriptionVerifier.verifyNotification(body.signedPayload);
    if (notification.transaction) await db.applyStoreTransaction(notification.transaction);
    return { ok: true, notificationType: notification.notificationType };
  });

  app.get("/api/status", async (request) => {
    const dashboard = isDashboardAuthorized(request, config);
    const access = dashboard ? null : await requireClientAccess(request, db);
    const [stats, sources] = await Promise.all([
      db.stats(),
      dashboard || access?.pro ? db.listSourceState() : Promise.resolve([]),
    ]);
    return {
      stats,
      sources,
      access,
      configuration: {
        sourceCount: config.rssSources.length
          + config.quoteMediaSources.length
          + Number(Boolean(config.x.bearerToken))
          + Number(Boolean(config.reddit.clientId && config.reddit.clientSecret))
          + Number(config.clinicalTrialsEnabled && config.watchlist.length > 0)
          + Number(config.secEnabled && config.watchlist.some((company) => company.cik))
          + Number(config.fdaAdcomEnabled),
        watchlistCount: config.watchlist.length,
        scanIntervalSeconds: config.scanIntervalSeconds,
        analysisMode: config.openaiApiKey ? "OpenAI structured analysis" : "demo heuristic (urgent alerts blocked)",
        model: config.openaiApiKey ? config.openaiModel : "heuristic-demo-v1",
        dryRun: config.alertPolicy.dryRun,
        apnsConfigured: Boolean(config.apns.teamId && config.apns.keyId && config.apns.bundleId
          && (config.apns.privateKey || config.apns.privateKeyPath)),
        criticalAlertsEnabled: config.apns.allowCritical,
        freeFeedDelayMinutes: config.entitlements.freeFeedDelayMinutes,
        marketData: {
          configured: marketData.configured,
          scope: config.alpaca.scope,
          feed: marketData.feed,
        },
        urgentThresholds: {
          materiality: config.alertPolicy.minMateriality,
          confidence: config.alertPolicy.minConfidence,
        },
      },
    };
  });

  app.get("/api/feed", async (request) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(250).default(100),
      scope: FeedModeSchema.optional(),
    }).parse(request.query);
    const dashboard = isDashboardAuthorized(request, config);
    const access = dashboard ? null : await requireClientAccess(request, db);
    const preferences = access ? await db.getInstallationPreferences(access.installationId) : null;
    const scope = dashboard ? "all" : query.scope ?? preferences?.feedMode ?? "all";
    const free = !dashboard && !access?.pro;
    const publishedBefore = free
      ? new Date(Date.now() - config.entitlements.freeFeedDelayMinutes * 60_000).toISOString()
      : null;
    const limit = free ? Math.min(query.limit, 30) : query.limit;
    const entries = await db.listFeed(limit, publishedBefore, scope === "watchlist" ? preferences?.watchedTickers ?? [] : null);
    return {
      entries: await attachMarketMovements(entries, marketData, canDisplayMarketData(config, access, dashboard), request.log),
      access,
      delayedByMinutes: free ? config.entitlements.freeFeedDelayMinutes : 0,
      scope,
    };
  });

  app.get("/api/signals/:id", async (request, reply) => {
    const dashboard = isDashboardAuthorized(request, config);
    const access = dashboard ? null : await requireClientAccess(request, db);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const item = await db.getItem(params.id);
    if (!item) return reply.code(404).send({ error: "signal_not_found" });
    if (!dashboard && !access?.pro) {
      const cutoff = Date.now() - config.entitlements.freeFeedDelayMinutes * 60_000;
      if (Date.parse(item.publishedAt) > cutoff) return reply.code(403).send({ error: "pro_required" });
    }
    const analysis = await db.getAnalysis(params.id);
    const [entry] = await attachMarketMovements([{
      item,
      analysis,
      corroborationCount: 0,
      alertedAt: null,
    }], marketData, canDisplayMarketData(config, access, dashboard), request.log);
    return entry ?? { item, analysis, marketMovement: null };
  });

  app.get("/api/watchlist", async (request) => {
    const dashboard = isDashboardAuthorized(request, config);
    const access = dashboard ? null : await requireClientAccess(request, db);
    const preferences = access ? await db.getInstallationPreferences(access.installationId) : null;
    const followed = new Set(preferences?.watchedTickers ?? []);
    return {
      access,
      preferences,
      limit: access ? watchlistLimit(config, access) : config.watchlist.length,
      companies: config.watchlist.map((watchCompany) => {
        const { ticker, company, aliases, marketCapBand, programs } = watchCompany;
        return {
        ticker,
        company,
        aliases,
        marketCapBand,
        programs,
          followed: followed.has(ticker),
          coverage: companyCoverage(config, watchCompany),
        };
      }),
    };
  });

  app.post("/api/scan", async (request, reply) => {
    if (!isDashboardAuthorized(request, config)) {
      const access = await requireClientAccess(request, db);
      if (!access.pro) throw httpError(403, "Catalyst Watch Pro is required to run a scan");
    }
    const result = await pipeline.run();
    return reply.code(result.alreadyRunning ? 202 : 200).send(result);
  });

  app.post("/api/devices", async (request, reply) => {
    const access = await requireClientAccess(request, db);
    const device = DeviceSchema.parse(request.body);
    if (device.installationId !== access.installationId) throw httpError(403, "Installation does not match");
    await db.upsertDevice(device);
    return reply.code(201).send({
      ok: true,
      pushEligible: access.pro,
      criticalAccepted: access.pro && config.apns.allowCritical && device.criticalAuthorized,
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", details: error.issues });
    const statusCode = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
    if (statusCode >= 500) app.log.error(error);
    const message = error instanceof Error ? error.message : "internal_error";
    return reply.code(statusCode).send({ error: statusCode < 500 ? message : "internal_error" });
  });
  return app;
}

async function attachMarketMovements(
  entries: readonly FeedEntry[],
  marketData: MarketDataProvider,
  enabled: boolean,
  logger: FastifyRequest["log"],
): Promise<Array<FeedEntry & { marketMovement: FeedEntry["marketMovement"] }>> {
  if (!enabled || !marketData.configured) return entries.map((entry) => ({ ...entry, marketMovement: null }));
  try {
    const candidates = entries.flatMap((entry) => {
      const assessment = entry.analysis?.assessment;
      const ticker = assessment?.isBiotechCatalyst ? assessment.ticker.trim() : "";
      return ticker ? [{ id: entry.item.id, ticker, publishedAt: entry.item.publishedAt }] : [];
    });
    if (!candidates.length) return entries.map((entry) => ({ ...entry, marketMovement: null }));
    const movements = await marketData.getMovements(candidates);
    return entries.map((entry) => ({ ...entry, marketMovement: movements.get(entry.item.id) ?? null }));
  } catch (error) {
    logger.warn({ err: error }, "Market movement enrichment failed");
    return entries.map((entry) => ({ ...entry, marketMovement: null }));
  }
}

function canDisplayMarketData(config: AppConfig, access: InstallationAccess | null, dashboard: boolean): boolean {
  if (config.alpaca.scope === "disabled") return false;
  if (config.alpaca.scope === "all") return true;
  return dashboard || access?.level === "developer";
}

async function requireClientAccess(request: FastifyRequest, db: SignalStore): Promise<InstallationAccess> {
  const installationId = headerValue(request, "x-installation-id");
  const clientToken = headerValue(request, "x-client-token");
  if (!z.string().uuid().safeParse(installationId).success || !/^[a-fA-F0-9]{64}$/.test(clientToken)) {
    throw httpError(401, "Installation credentials are required");
  }
  if (!await db.installationTokenMatches(installationId, hashToken(clientToken))) {
    throw httpError(401, "Installation credentials were not accepted");
  }
  const access = await db.getInstallationAccess(installationId);
  if (!access) throw httpError(401, "Installation is not registered");
  return access;
}

function isDashboardAuthorized(request: FastifyRequest, config: AppConfig): boolean {
  if (!config.dashboardToken && ["127.0.0.1", "::1"].includes(request.ip)) return true;
  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return Boolean(config.dashboardToken && token && safeEqual(token, config.dashboardToken));
}

function entitlementResponse(config: AppConfig, access: InstallationAccess | null) {
  if (!access) throw httpError(404, "Installation is not registered");
  return {
    access,
    products: config.entitlements.productIds,
    freeFeedDelayMinutes: config.entitlements.freeFeedDelayMinutes,
  };
}

function preferencesResponse(
  config: AppConfig,
  access: InstallationAccess,
  preferences: Awaited<ReturnType<SignalStore["getInstallationPreferences"]>>,
) {
  return {
    access,
    preferences,
    limits: {
      watchlist: watchlistLimit(config, access),
      monitoredUniverse: config.watchlist.length,
    },
    eventTypes: CatalystEventTypeSchema.options,
  };
}

function watchlistLimit(config: AppConfig, access: InstallationAccess): number {
  return access.pro ? config.watchlist.length : Math.min(FREE_WATCHLIST_LIMIT, config.watchlist.length);
}

function companyCoverage(config: AppConfig, company: WatchCompany): CompanyCoverage {
  const quoteMediaSources = config.quoteMediaSources.filter((source) => (
    source.symbol === company.ticker || source.symbols.includes(company.ticker) || source.watchlist
  ));
  const companyIr = quoteMediaSources.some((source) => source.sourceType === "company_ir")
    || config.rssSources.some((source) => source.sourceType === "company_ir" && source.tickers.includes(company.ticker));
  const coverage = {
    sec: Boolean(company.cik && config.secEnabled),
    clinicalTrials: config.clinicalTrialsEnabled,
    pressReleases: quoteMediaSources.length > 0,
    companyIr,
    programMetadata: company.programs.length > 0,
  };
  const score = Object.values(coverage).filter(Boolean).length;
  return { ...coverage, level: score >= 5 ? "complete" : score >= 3 ? "strong" : "core" };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function headerValue(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
