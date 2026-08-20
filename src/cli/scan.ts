import { bootstrap } from "../bootstrap.js";

const logger = {
  info: (bindings: Record<string, unknown>, message?: string) => console.log(message ?? "info", bindings),
  warn: (bindings: Record<string, unknown>, message?: string) => console.warn(message ?? "warn", bindings),
  error: (bindings: Record<string, unknown>, message?: string) => console.error(message ?? "error", bindings),
};

const { db, pipeline } = bootstrap(logger);
try {
  const result = await pipeline.run();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.errorCount ? 1 : 0;
} finally {
  db.close();
}
