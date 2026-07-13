import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spawn = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn,
}));

const {
  banner, cachePath, readCache, isStale, isSilenced, maybeNotify, sdkVersion, PACKAGE_NAME, TTL_MS,
} = await import('../src/cli/update-check.js');
const { fetchLatest, writeCache, refresh } = await import('../src/cli/update-check-worker.js');

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'update-check-'));
  spawn.mockClear();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('banner', () => {
  it('announces only a strictly newer version', () => {
    expect(banner('1.2.0', '1.5.0')).toContain('1.2.0 → 1.5.0');
    expect(banner('1.5.0', '1.5.0')).toBeNull();
    expect(banner('1.6.0', '1.5.0')).toBeNull();
  });

  it('says nothing when either version is unparseable', () => {
    expect(banner('not-a-version', '1.5.0')).toBeNull();
    expect(banner('1.2.0', 'garbage')).toBeNull();
  });
});

describe('sdkVersion', () => {
  it("reads this package's real version", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(sdkVersion()).toBe(pkg.version);
  });
});

describe('cachePath', () => {
  it('prefers XDG_CACHE_HOME, else ~/.cache', () => {
    expect(cachePath({ XDG_CACHE_HOME: '/xdg' }, '/home/a', '/tmp'))
      .toBe(path.join('/xdg', PACKAGE_NAME, 'update-check.json'));
    expect(cachePath({}, '/home/a', '/tmp'))
      .toBe(path.join('/home/a', '.cache', PACKAGE_NAME, 'update-check.json'));
  });
});

describe('readCache', () => {
  it('reads a well-formed cache', () => {
    const f = path.join(tmp, 'c.json');
    fs.writeFileSync(f, JSON.stringify({ lastCheck: 42, latest: '9.9.9' }));
    expect(readCache(f)).toEqual({ lastCheck: 42, latest: '9.9.9' });
  });

  it('returns null — never throws — for missing, corrupt or wrong-shaped files', () => {
    expect(readCache(path.join(tmp, 'nope.json'))).toBeNull();

    const corrupt = path.join(tmp, 'corrupt.json');
    fs.writeFileSync(corrupt, '{not json');
    expect(readCache(corrupt)).toBeNull();

    const wrong = path.join(tmp, 'wrong.json');
    fs.writeFileSync(wrong, JSON.stringify({ latest: 5 }));
    expect(readCache(wrong)).toBeNull();
  });
});

describe('isStale', () => {
  it('treats an absent cache as stale, and expires at the TTL boundary', () => {
    expect(isStale(null, 1_000_000)).toBe(true);
    expect(isStale({ lastCheck: 1000, latest: '1.0.0' }, 1000 + TTL_MS - 1)).toBe(false);
    expect(isStale({ lastCheck: 1000, latest: '1.0.0' }, 1000 + TTL_MS)).toBe(true);
  });
});

describe('isSilenced', () => {
  it('is silent in CI, when opted out, and when stderr is not a TTY', () => {
    expect(isSilenced({ CI: '1' }, true)).toBe(true);
    expect(isSilenced({ NO_UPDATE_NOTIFIER: '1' }, true)).toBe(true);
    expect(isSilenced({ TREK_SDK_NO_UPDATE_CHECK: '1' }, true)).toBe(true);
    expect(isSilenced({}, false)).toBe(true);
    expect(isSilenced({}, true)).toBe(false);
  });
});

describe('maybeNotify', () => {
  /** A human at a terminal, with $XDG_CACHE_HOME pointed at the temp dir. */
  function asHuman(): ReturnType<typeof vi.spyOn> {
    vi.stubEnv('CI', '');
    vi.stubEnv('NO_UPDATE_NOTIFIER', '');
    vi.stubEnv('TREK_SDK_NO_UPDATE_CHECK', '');
    vi.stubEnv('XDG_CACHE_HOME', tmp);
    vi.spyOn(process.stderr, 'isTTY', 'get').mockReturnValue(true);
    return vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  }

  function seedCache(cache: { lastCheck: number; latest: string }): void {
    const f = path.join(tmp, PACKAGE_NAME, 'update-check.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(cache));
  }

  it('prints the notice when a fresh cache holds a newer version', () => {
    const write = asHuman();
    seedCache({ lastCheck: Date.now(), latest: '999.0.0' });

    maybeNotify();

    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0][0])).toContain(`999.0.0 · npm i -g ${PACKAGE_NAME}@latest`);
    expect(spawn).not.toHaveBeenCalled(); // fresh cache — no refresh
  });

  it('prints nothing when the cached version is the one we are running', () => {
    const write = asHuman();
    seedCache({ lastCheck: Date.now(), latest: sdkVersion() });

    maybeNotify();

    expect(write).not.toHaveBeenCalled();
  });

  it('is silent on a cold cache, but spawns the background refresh for next time', () => {
    const write = asHuman();

    maybeNotify();

    expect(write).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    const [, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(args[0]).toMatch(/update-check-worker\.js$/);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('refreshes a stale cache while still printing what it knows', () => {
    const write = asHuman();
    seedCache({ lastCheck: Date.now() - TTL_MS - 1, latest: '999.0.0' });

    maybeNotify();

    expect(write).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('does nothing at all — no print, no spawn — when silenced', () => {
    const write = asHuman();
    vi.stubEnv('CI', '1');
    seedCache({ lastCheck: Date.now(), latest: '999.0.0' });

    maybeNotify();

    expect(write).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('survives a corrupt cache without throwing', () => {
    const write = asHuman();
    const f = path.join(tmp, PACKAGE_NAME, 'update-check.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'not json at all');

    expect(() => maybeNotify()).not.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce(); // unreadable == no news == refresh
  });
});

describe('worker', () => {
  it('returns the latest dist-tag version', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '2.0.0' }))));
    await expect(fetchLatest()).resolves.toBe('2.0.0');
  });

  it('returns null on a non-200, a malformed body, or a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(fetchLatest()).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 42 }))));
    await expect(fetchLatest()).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    await expect(fetchLatest()).resolves.toBeNull();
  });

  it('writes the cache only when the fetch succeeded', async () => {
    const f = path.join(tmp, 'sub', 'update-check.json');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await refresh(f, 123);
    expect(fs.existsSync(f)).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '3.1.0' }))));
    await refresh(f, 123);
    expect(readCache(f)).toEqual({ lastCheck: 123, latest: '3.1.0' });
  });

  it('gives up silently when the cache is unwritable', () => {
    expect(() => writeCache('/proc/definitely/not/writable.json', { lastCheck: 1, latest: '1.0.0' })).not.toThrow();
  });
});
