/**
 * Optional disk cache for notice details.
 * Keyed by `${source}:${notice_id}`. Default TTL: 30 days.
 *
 * Cache lives in OS temp dir under `vergabe-mcp-cache/` so users don't need
 * to provision anything. Override with env var VERGABE_MCP_CACHE_DIR.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days
const CACHE_DIR =
  process.env.VERGABE_MCP_CACHE_DIR ?? join(tmpdir(), "vergabe-mcp-cache");

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function keyToPath(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return join(CACHE_DIR, `${hash}.json`);
}

type CacheEntry<T> = {
  key: string;
  stored_at: number;
  ttl_ms: number;
  value: T;
};

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    ensureCacheDir();
    const path = keyToPath(key);
    if (!existsSync(path)) return null;
    const raw = await fs.readFile(path, "utf8");
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (Date.now() - entry.stored_at > entry.ttl_ms) {
      // Expired — best-effort cleanup, ignore errors.
      fs.unlink(path).catch(() => {});
      return null;
    }
    return entry.value;
  } catch (err) {
    console.error(`[cache] get failed for ${key}: ${(err as Error).message}`);
    return null;
  }
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<void> {
  try {
    ensureCacheDir();
    const path = keyToPath(key);
    const entry: CacheEntry<T> = {
      key,
      stored_at: Date.now(),
      ttl_ms: ttlMs,
      value,
    };
    await fs.writeFile(path, JSON.stringify(entry), "utf8");
  } catch (err) {
    console.error(`[cache] set failed for ${key}: ${(err as Error).message}`);
  }
}

export function getCacheDir(): string {
  return CACHE_DIR;
}
