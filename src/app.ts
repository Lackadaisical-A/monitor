import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { SignalDatabase } from "./db.js";
import type { MonitorPipeline } from "./pipeline.js";
import { safeEqual } from "./utils.js";

const DeviceSchema = z.object({
  installationId: z.string().uuid(),
  deviceToken: z.string().regex(/^[a-fA-F0-9]{64,200}$/),
  environment: z.enum(["sandbox", "production"]),
  timeSensitiveAuthorized: z.boolean(),
  criticalAuthorized: z.boolean(),
});

export async function createApp(config: AppConfig, db: SignalDatabase, pipeline: MonitorPipeline): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel } });
  const publicPath = resolve("public");
  if (existsSync(publicPath)) {
    await app.register(fastifyStatic, { root: publicPath, prefix: "/" });
  }

  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

  app.get("/api/status", { preHandler: authorizeAny(config) }, async () => ({
    stats: db.stats(),
    sources: db.listSourceState(),
    configuration: {
      sourceCount: config.rssSources.length
        + Number(Boolean(config.x.bearerToken))
        + Number(Boolean(config.reddit.clientId && config.reddit.clientSecret))
        + Number(config.clinicalTrialsEnabled && config.watchlist.length > 0)
        + Number(config.secEnabled && config.watchlist.some((company) => company.cik)),
      watchlistCount: config.watchlist.length,
      analysisMode: config.openaiApiKey ? "OpenAI structured analysis" : "demo heuristic (urgent alerts blocked)",
      model: config.openaiApiKey ? config.openaiModel : "heuristic-demo-v1",
      dryRun: config.alertPolicy.dryRun,
      apnsConfigured: Boolean(config.apns.teamId && config.apns.keyId && config.apns.privateKeyPath),
      criticalAlertsEnabled: config.apns.allowCritical,
      urgentThresholds: {
        materiality: config.alertPolicy.minMateriality,
        confidence: config.alertPolicy.minConfidence,
      },
    },
  }));

  app.get("/api/feed", { preHandler: authorizeAny(config) }, async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(250).default(100) }).parse(request.query);
    return { entries: db.listFeed(query.limit) };
  });

  app.get("/api/signals/:id", { preHandler: authorizeAny(config) }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const item = db.getItem(params.id);
    if (!item) return reply.code(404).send({ error: "signal_not_found" });
    return { item, analysis: db.getAnalysis(params.id) };
  });

  app.post("/api/scan", { preHandler: authorizeDashboard(config) }, async (_request, reply) => {
    const result = await pipeline.run();
    return reply.code(result.alreadyRunning ? 202 : 200).send(result);
  });

  app.post("/api/devices", { preHandler: authorizePairing(config) }, async (request, reply) => {
    const device = DeviceSchema.parse(request.body);
    db.upsertDevice(device);
    return reply.code(201).send({ ok: true, criticalAccepted: config.apns.allowCritical && device.criticalAuthorized });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", details: error.issues });
    app.log.error(error);
    const statusCode = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
    const message = error instanceof Error ? error.message : "internal_error";
    return reply.code(statusCode).send({ error: statusCode < 500 ? message : "internal_error" });
  });
  return app;
}

function authorizeAny(config: AppConfig) {
  return async (request: FastifyRequest): Promise<void> => {
    if (isDashboardAuthorized(request, config) || isPairingAuthorized(request, config)) return;
    const error = new Error("Unauthorized") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  };
}

function authorizeDashboard(config: AppConfig) {
  return async (request: FastifyRequest): Promise<void> => {
    if (isDashboardAuthorized(request, config)) return;
    const error = new Error("Unauthorized") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  };
}

function authorizePairing(config: AppConfig) {
  return async (request: FastifyRequest): Promise<void> => {
    if (isPairingAuthorized(request, config)) return;
    const error = new Error("Unauthorized") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  };
}

function isDashboardAuthorized(request: FastifyRequest, config: AppConfig): boolean {
  if (!config.dashboardToken && ["127.0.0.1", "::1"].includes(request.ip)) return true;
  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return Boolean(config.dashboardToken && token && safeEqual(token, config.dashboardToken));
}

function isPairingAuthorized(request: FastifyRequest, config: AppConfig): boolean {
  const value = request.headers["x-pairing-token"];
  const token = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  return Boolean(config.devicePairingToken && token && safeEqual(token, config.devicePairingToken));
}
