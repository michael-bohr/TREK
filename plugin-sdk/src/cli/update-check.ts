/**
 * "Your SDK is out of date" — the advisory update notice (#plugins).
 *
 * A stale SDK is not a cosmetic problem: the registry-entry format, the manifest
 * validator and the permission catalog all move with the host, so an author on an
 * old SDK can happily `pack` and `submit` an entry that today's registry CI rejects.
 *
 * Three rules keep this safe to call from the top of every command:
 *  1. ZERO added latency. The command only ever prints from a cache file; the
 *     refresh runs in a DETACHED child (see update-check-worker.ts). An un-awaited
 *     in-process fetch() would NOT do — Node keeps the socket alive and won't exit
 *     until it resolves, so every command would pay ~300ms.
 *  2. STDERR only. stdout is a pure data channel (`entry`, `pack --json`, PR URLs) —
 *     see the contract in ui.ts.
 *  3. It CANNOT fail a command. Every path is wrapped; a broken cache, a missing
 *     worker or an offline machine are all silently indistinguishable from "no news".
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

export const PACKAGE_NAME = 'trek-plugin-sdk';
export const CACHE_FILE = 'update-check.json';
export const TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCache {
  /** Epoch ms of the last successful registry read. */
  lastCheck: number;
  /** The `latest` dist-tag as of `lastCheck`. */
  latest: string;
}

/** This package's own version — the thing we compare the registry against. */
export function sdkVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Where the cache lives. Takes its inputs as arguments (rather than reading the
 * environment itself) so tests can point it at a temp dir without touching $HOME.
 */
export function cachePath(env: NodeJS.ProcessEnv = process.env, homedir = os.homedir(), tmpdir = os.tmpdir()): string {
  const base = env.XDG_CACHE_HOME || (homedir ? path.join(homedir, '.cache') : tmpdir);
  return path.join(base, PACKAGE_NAME, CACHE_FILE);
}

/** Missing, unreadable, corrupt, or wrong-shaped — all are simply "no news". Never throws. */
export function readCache(file: string): UpdateCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<UpdateCache>;
    if (typeof raw?.lastCheck !== 'number' || typeof raw?.latest !== 'string') return null;
    return { lastCheck: raw.lastCheck, latest: raw.latest };
  } catch {
    return null;
  }
}

/** An absent cache is stale — that is what triggers the very first refresh. */
export function isStale(cache: UpdateCache | null, now: number, ttlMs: number = TTL_MS): boolean {
  return !cache || now - cache.lastCheck >= ttlMs;
}

/**
 * The notice is for humans at a terminal, and for nobody else: not CI logs, not
 * pipes, and not authors who have opted out.
 */
export function isSilenced(env: NodeJS.ProcessEnv = process.env, isTTY: boolean = Boolean(process.stderr.isTTY)): boolean {
  if (env.TREK_SDK_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI) return true;
  return !isTTY;
}

/** The notice itself — `null` when there is nothing to say (same version, or ahead of it). */
export function banner(current: string, latest: string): string | null {
  if (!semver.valid(current) || !semver.valid(latest) || !semver.gt(latest, current)) return null;
  const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
  return dim(`\n  Update available ${current} → ${latest} · npm i -g ${PACKAGE_NAME}@latest\n`);
}

/** Detached + unref'd, so the parent process exits the instant its own work is done. */
function spawnRefresh(): void {
  const worker = fileURLToPath(new URL('./update-check-worker.js', import.meta.url));
  spawn(process.execPath, [worker], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * The one entry point. Call it at the top of a command; it returns immediately.
 * Prints from cache, and refreshes that cache in the background for the NEXT run —
 * which is why a brand-new install learns about an update one run late. That is the
 * price of never making an author wait on the network.
 */
export function maybeNotify(now: number = Date.now()): void {
  try {
    if (isSilenced()) return;
    const cache = readCache(cachePath());
    if (cache) {
      const msg = banner(sdkVersion(), cache.latest);
      if (msg) process.stderr.write(msg);
    }
    if (isStale(cache, now)) spawnRefresh();
  } catch {
    // An update notice is never worth failing a command over.
  }
}
