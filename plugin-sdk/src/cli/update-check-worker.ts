#!/usr/bin/env node
/**
 * The background half of the update notice (#plugins) — see update-check.ts.
 *
 * Spawned detached and unref'd, so nothing is waiting on it: it asks npm for the
 * `latest` dist-tag, writes the cache the NEXT command will read, and exits. It
 * prints nothing, ever, and every failure (offline, DNS, 404, timeout, read-only
 * cache dir) is a silent no-op — the author is not debugging our update check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_NAME, cachePath, type UpdateCache } from './update-check.js';

const REGISTRY = 'https://registry.npmjs.org';
/** Generous: nobody is waiting on this process. */
const TIMEOUT_MS = 3000;

/** Ask the registry for the `latest` dist-tag. `null` on any failure. */
export async function fetchLatest(registry: string = REGISTRY): Promise<string | null> {
  try {
    const res = await fetch(`${registry}/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body?.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

/** Write the cache the next command reads. Silently gives up if it can't. */
export function writeCache(file: string, cache: UpdateCache): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
  } catch {
    // A cache we can't write just means we check again next time.
  }
}

/** Fetch → cache. Exported whole so the tests can drive it with a stubbed `fetch`. */
export async function refresh(file: string = cachePath(), now: number = Date.now()): Promise<void> {
  const latest = await fetchLatest();
  if (latest) writeCache(file, { lastCheck: now, latest });
}

// Bin entry. Never throws, never prints, always exits 0.
if (process.argv[1] && process.argv[1].endsWith('update-check-worker.js')) {
  refresh().catch(() => {}).finally(() => process.exit(0));
}
