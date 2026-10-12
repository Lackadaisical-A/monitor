import { createApp } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import { BuybackMonitor } from "./buyback.js";

const bootstrapLogger = {
  info: (bindings: Record<string, unknown>, message?: string) => console.log(message ?? "info", bindings),
  warn: (bindings: Record<string, unknown>, message?: string) => console.warn(message ?? "warn", bindings),
  error: (bindings: Record<string, unknown>, message?: string) => console.error(message ?? "error", bindings),
};

const { config, db, marketData, clubSheets, pipeline } = bootstrap(bootstrapLogger);
await pipeline.reconcileStoredPolicies();
await pipeline.requeueOutdatedAnalyses();
const buyback = new BuybackMonitor(config, bootstrapLogger);
const app = await createApp(config, db, pipeline, undefined, marketData, clubSheets, buyback);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  if (scanTimer) clearInterval(scanTimer);
  if (clubSheetTimer) clearInterval(clubSheetTimer);
  await app.close();
  await buyback.stop();
  db.close();
  process.exit(0);
};

const scanTimer = config.catalystEnabled === false ? null : setInterval(() => {
  void pipeline.run().catch((error) => app.log.error(error));
}, config.scanIntervalSeconds * 1000);
scanTimer?.unref();
const clubSheetTimer = clubSheets
  ? setInterval(() => clubSheets.requestSync(), config.club.sheets.syncIntervalSeconds * 1_000)
  : null;
clubSheetTimer?.unref();

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

await app.listen({ port: config.port, host: config.host });
app.log.info({ host: config.host, port: config.port }, "Biotech Signal Monitor listening");
clubSheets?.requestSync();
buyback.start();
if (config.catalystEnabled !== false) void pipeline.run().catch((error) => app.log.error(error));
