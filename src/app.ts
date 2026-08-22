import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { SignalDatabase } from "./db.js";
import type { MonitorPipeline } from "./pipeline.js";
import { AppStoreSubscriptionVerifier, type SubscriptionVerifier } from "./subscriptions.js";
import type { InstallationAccess } from "./types.js";
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

export async function createApp(
  config: AppConfig,
  db: SignalDatabase,
  pipeline: MonitorPipeline,
  subscriptionVerifier: SubscriptionVerifier = new AppStoreSubscriptionVerifier(config.entitlements),
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 300_000,
  });
  const publicPath = resolve("public");
  if (existsSync(publicPath)) {
    await app.register(fastifyStatic, { root: publicPath, prefix: "/" });
  }

  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

  app.post("/api/installations", async (request, reply) => {
    const installation = InstallationSchema.parse(request.body);
    const registered = db.registerInstallation(installation.installationId, hashToken(installation.clientToken));
    if (!registered) throw httpError(401, "Installation credentials were not accepted");
    return reply.code(201).send(entitlementResponse(config, db.getInstallationAccess(installation.installationId)));
  });

  app.get("/api/entitlements", async (request) => {
    const access = requireClientAccess(request, db);
    return entitlementResponse(config, access);
  });

  app.post("/api/entitlements/storekit", async (request) => {
    const access = requireClientAccess(request, db);
    const body = SignedTransactionSchema.parse(request.body);
    const entitlement = await subscriptionVerifier.verifyTransaction(body.signedTransaction, access.installationId);
    db.applyStoreTransaction(entitlement);
    return entitlementResponse(config, db.getInstallationAccess(access.installationId));
  });

  app.post("/api/entitlements/developer", async (request) => {
    const access = requireClientAccess(request, db);
    const body = DeveloperCredentialSchema.parse(request.body);
    if (!config.entitlements.developerPairingToken
      || !safeEqual(body.credential, config.entitlements.developerPairingToken)) {
      throw httpError(401, "Developer credential was not accepted");
    }
    db.activateDeveloperAccess(access.installationId);
    return entitlementResponse(config, db.getInstallationAccess(access.installationId));
  });

  app.post("/api/app-store/notifications", async (request) => {
    const body = NotificationSchema.parse(request.body);
    const notification = await subscriptionVerifier.verifyNotification(body.signedPayload);
    if (notification.transaction) db.applyStoreTransaction(notification.transaction);
    return { ok: true, notificationType: notification.notificationType };
  });

  app.get("/api/status", async (request) => {
    const dashboard = isDashboardAuthorized(request, config);
    const access = dashboard ? null : requireClientAccess(request, db);
    return {
      stats: db.stats(),
      sources: dashboard || access?.pro ? db.listSourceState() : [],
      access,
      configuration: {
        sourceCount: config.rssSources.length
          + config.quoteMediaSources.length
          + Number(Boolean(config.x.bearerToken))
          + Number(Boolean(config.reddit.clientId && config.reddit.clientSecret))
          + Number(config.clinicalTrialsEnabled && config.watchlist.length > 0)
          + Number(config.secEnabled && config.watchlist.some((company) => company.cik)),
        watchlistCount: config.watchlist.length,
        analysisMode: config.openaiApiKey ? "OpenAI structured analysis" : "demo heuristic (urgent alerts blocked)",
        model: config.openaiApiKey ? config.openaiModel : "heuristic-demo-v1",
        dryRun: config.alertPolicy.dryRun,
        apnsConfigured: Boolean(config.apns.teamId && config.apns.keyId && config.apns.bundleId
          && (config.apns.privateKey || config.apns.privateKeyPath)),
        criticalAlertsEnabled: config.apns.allowCritical,
        freeFeedDelayMinutes: config.entitlements.freeFeedDelayMinutes,
        urgentThresholds: {
          materiality: config.alertPolicy.minMateriality,
          confidence: config.alertPolicy.minConfidence,
        },
      },
    };
  });

  app.get("/api/feed", async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(250).default(100) }).parse(request.query);
    const dashboard = isDashboardAuthorized(request, config);
    const access = dashboard ? null : requireClientAccess(request, db);
    const free = !dashboard && !access?.pro;
    const publishedBefore = free
      ? new Date(Date.now() - config.entitlements.freeFeedDelayMinutes * 60_000).toISOString()
      : null;
    const limit = free ? Math.min(query.limit, 30) : query.limit;
    return {
      entries: db.listFeed(limit, publishedBefore),
      access,
      delayedByMinutes: free ? config.entitlements.freeFeedDelayMinutes : 0,
    };
  });

  app.get("/api/signals/:id", async (request, reply) => {
    const dashboard = isDashboardAuthorized(request, config);
    const access = dashboard ? null : requireClientAccess(request, db);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const item = db.getItem(params.id);
    if (!item) return reply.code(404).send({ error: "signal_not_found" });
    if (!dashboard && !access?.pro) {
      const cutoff = Date.now() - config.entitlements.freeFeedDelayMinutes * 60_000;
      if (Date.parse(item.publishedAt) > cutoff) return reply.code(403).send({ error: "pro_required" });
    }
    return { item, analysis: db.getAnalysis(params.id) };
  });

  app.post("/api/scan", async (request, reply) => {
    if (!isDashboardAuthorized(request, config)) {
      const access = requireClientAccess(request, db);
      if (!access.pro) throw httpError(403, "Catalyst Watch Pro is required to run a scan");
    }
    const result = await pipeline.run();
    return reply.code(result.alreadyRunning ? 202 : 200).send(result);
  });

  app.post("/api/devices", async (request, reply) => {
    const access = requireClientAccess(request, db);
    const device = DeviceSchema.parse(request.body);
    if (device.installationId !== access.installationId) throw httpError(403, "Installation does not match");
    db.upsertDevice(device);
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

function requireClientAccess(request: FastifyRequest, db: SignalDatabase): InstallationAccess {
  const installationId = headerValue(request, "x-installation-id");
  const clientToken = headerValue(request, "x-client-token");
  if (!z.string().uuid().safeParse(installationId).success || !/^[a-fA-F0-9]{64}$/.test(clientToken)) {
    throw httpError(401, "Installation credentials are required");
  }
  if (!db.installationTokenMatches(installationId, hashToken(clientToken))) {
    throw httpError(401, "Installation credentials were not accepted");
  }
  const access = db.getInstallationAccess(installationId);
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
