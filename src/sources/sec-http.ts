import { fetchWithTimeout } from "./http.js";

const REQUEST_INTERVAL_MS = 130;
const MAX_ATTEMPTS = 3;

let nextRequestAt = 0;
let rateGate: Promise<void> = Promise.resolve();

export async function fetchSec(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let releaseGate!: () => void;
    const previousGate = rateGate;
    rateGate = new Promise<void>((resolve) => { releaseGate = resolve; });
    await previousGate;
    try {
      const waitMs = Math.max(0, nextRequestAt - Date.now());
      if (waitMs > 0) await delay(waitMs);
      nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
    } finally {
      releaseGate();
    }
    try {
      return await fetchWithTimeout(input, init, Math.max(timeoutMs, 15_000));
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS - 1) await delay(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
