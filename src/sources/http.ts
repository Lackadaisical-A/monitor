export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}
