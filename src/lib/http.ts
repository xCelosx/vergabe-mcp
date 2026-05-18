/**
 * HTTP wrapper with retry, backoff and per-host rate-limiting.
 * - Retries on 429 / 5xx with exponential backoff (1s, 4s, 16s; max 3 attempts).
 * - Per-host token-bucket so callers can stay below source-specific rate limits.
 * - All logging uses console.error (stderr) because stdout is reserved for the
 *   MCP stdio protocol.
 */
import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
} from "axios";

type RateBucket = {
  /** Min interval between requests in ms. */
  minIntervalMs: number;
  /** Timestamp of last permitted request. */
  lastRequestAt: number;
};

const buckets = new Map<string, RateBucket>();

/**
 * Register a rate limit for a given host. Subsequent requests via httpGet()
 * to that host will be throttled accordingly.
 */
export function registerRateLimit(host: string, requestsPerSecond: number): void {
  buckets.set(host, {
    minIntervalMs: Math.ceil(1000 / requestsPerSecond),
    lastRequestAt: 0,
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function waitForBucket(host: string): Promise<void> {
  const bucket = buckets.get(host);
  if (!bucket) return;
  const now = Date.now();
  const elapsed = now - bucket.lastRequestAt;
  if (elapsed < bucket.minIntervalMs) {
    const wait = bucket.minIntervalMs - elapsed;
    await sleep(wait);
  }
  bucket.lastRequestAt = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const axiosInstance: AxiosInstance = axios.create({
  timeout: 30_000,
  headers: {
    "User-Agent": "vergabe-mcp/1.1.0 (+https://github.com/xCelosx/vergabe-mcp)",
    Accept: "application/json",
  },
  // Allow non-2xx so we can decide on retry per status.
  validateStatus: () => true,
});

export type HttpResult<T = any> = {
  status: number;
  data: T;
  headers: Record<string, any>;
  url: string;
};

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 4_000, 16_000];

export async function httpGet<T = any>(
  url: string,
  config: AxiosRequestConfig = {}
): Promise<HttpResult<T>> {
  const host = hostOf(url);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await waitForBucket(host);
    try {
      const res: AxiosResponse<T> = await axiosInstance.get<T>(url, config);

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < MAX_ATTEMPTS - 1) {
          const wait = BACKOFF_MS[attempt] ?? 16_000;
          console.error(
            `[http] ${url} -> ${res.status}, retry in ${wait}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`
          );
          await sleep(wait);
          continue;
        }
      }

      return {
        status: res.status,
        data: res.data,
        headers: res.headers as Record<string, any>,
        url,
      };
    } catch (err) {
      const error = err as AxiosError;
      if (attempt < MAX_ATTEMPTS - 1) {
        const wait = BACKOFF_MS[attempt] ?? 16_000;
        console.error(
          `[http] ${url} -> error ${error.message}, retry in ${wait}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`
        );
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`httpGet exhausted retries for ${url}`);
}

export async function httpGetBinary(url: string): Promise<HttpResult<Buffer>> {
  const host = hostOf(url);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await waitForBucket(host);
    try {
      const res = await axiosInstance.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
      });
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < MAX_ATTEMPTS - 1) {
          const wait = BACKOFF_MS[attempt] ?? 16_000;
          await sleep(wait);
          continue;
        }
      }
      return {
        status: res.status,
        data: Buffer.from(res.data),
        headers: res.headers as Record<string, any>,
        url,
      };
    } catch (err) {
      const error = err as AxiosError;
      if (attempt < MAX_ATTEMPTS - 1) {
        const wait = BACKOFF_MS[attempt] ?? 16_000;
        console.error(
          `[http] binary ${url} -> error ${error.message}, retry in ${wait}ms`
        );
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`httpGetBinary exhausted retries for ${url}`);
}
