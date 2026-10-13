import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import type { PipelineLogger } from "./pipeline.js";

export interface BuybackStatusProvider {
  snapshot(): Promise<Record<string, unknown>>;
  setEntriesPaused?(paused: boolean): Promise<void>;
}

/** Isolated from the club database and API lifecycle: a feed failure cannot stop check-in. */
export class BuybackMonitor implements BuybackStatusProvider {
  private child: ChildProcess | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private lastError: string | null = null;
  private restartCount = 0;

  constructor(private readonly config: AppConfig, private readonly logger: PipelineLogger) {}

  start(): void {
    const options = this.config.buyback;
    if (!options?.enabled || this.stopping || this.child) return;
    const child = spawn(options.python, ["-u", resolve("buyback/worker.py"), "--data-dir", options.dataDir], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        BUYBACK_STREAM_ENABLED: String(options.streamEnabled),
        ALPACA_API_KEY_ID: this.config.alpaca.keyId,
        ALPACA_API_SECRET_KEY: this.config.alpaca.secretKey,
        OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1",
      },
    });
    this.child = child;
    this.lastError = null;
    child.stdout?.on("data", (chunk: Buffer) => this.logger.info({ message: chunk.toString().trim().slice(0, 2000) }, "buyback worker"));
    child.stderr?.on("data", (chunk: Buffer) => this.logger.warn({ message: chunk.toString().trim().slice(0, 2000) }, "buyback worker"));
    child.on("error", () => { this.lastError = "Buyback worker could not start"; });
    child.on("close", (code) => {
      this.child = null;
      if (!this.stopping) {
        this.lastError ??= `Buyback worker exited (${code ?? "signal"})`;
        this.restartCount += 1;
        this.retry = setTimeout(() => this.start(), Math.min(60_000, 5_000 * this.restartCount));
        this.retry.unref();
      }
    });
  }

  async snapshot(): Promise<Record<string, unknown>> {
    const enabled = this.config.buyback?.enabled ?? false;
    let status: Record<string, unknown> = {};
    if (enabled && this.config.buyback) {
      try { status = JSON.parse(await readFile(resolve(this.config.buyback.dataDir, "status.json"), "utf8")); }
      catch { /* A missing snapshot is explicitly unhealthy until the first capture. */ }
    }
    const age = typeof status.updatedAt === "string" ? (Date.now() - Date.parse(status.updatedAt)) / 1000 : Infinity;
    const healthy = enabled && Boolean(this.child) && age >= 0 && age < 180 && status.healthy === true;
    return {
      ...status, enabled, healthy, mode: status.mode ?? "read_only",
      ordersEnabled: Boolean(this.child) && age >= 0 && age < 120 && status.ordersEnabled === true,
      catalystEnabled: this.config.catalystEnabled !== false,
      workerRunning: Boolean(this.child), workerError: this.lastError,
      restartCount: this.restartCount, heartbeatAgeSeconds: Number.isFinite(age) ? Math.round(age) : null,
    };
  }

  async setEntriesPaused(paused: boolean): Promise<void> {
    const dir = this.config.buyback?.dataDir;
    if (!dir) throw new Error("Buyback monitor is not configured");
    await mkdir(dir, { recursive: true });
    const temporary = resolve(dir, `.trading-control-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ entriesPaused: paused, updatedAt: new Date().toISOString() }), { mode: 0o600 });
    await rename(temporary, resolve(dir, "trading-control.json"));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retry) clearTimeout(this.retry);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
      timer.unref();
      child.once("close", () => { clearTimeout(timer); done(); });
      child.kill("SIGTERM");
    });
  }
}
