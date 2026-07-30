/**
 * MailIngestService — SSRF guard on the user-supplied IMAP host (Fix 3).
 *
 * checkSsrf()'s own DNS-resolution / private-IP-classification logic is
 * covered by tests/unit/utils/ssrfGuard.test.ts; checkSsrf() itself is mocked
 * here so this suite is scoped to exactly what Fix 3 owns: a host that fails
 * the SSRF check is rejected on the save path (addSource), the "Test
 * connection" path (testConfig), the scheduled poll (runTick → pollSource,
 * via providerFor()), and "Catch up" (catchUp, via providerFor()) — and,
 * critically, rejected BEFORE ImapProvider ever opens a socket to it (no
 * constructor call, no testConnection()/fetchNew()/scanSince() call). The
 * poll/catch-up cases matter independently of addSource's save-time check:
 * the host is only a hostname at rest, and DNS can re-resolve to a different
 * (internal) address between save time and connect time.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BookingImportService } from '../../../../src/nest/booking-import/booking-import.service';

const { checkSsrf } = vi.hoisted(() => ({ checkSsrf: vi.fn() }));
vi.mock('../../../../src/utils/ssrfGuard', () => ({ checkSsrf }));

const { ImapProviderCtor, testConnection, uidNext } = vi.hoisted(() => ({
  ImapProviderCtor: vi.fn(),
  testConnection: vi.fn().mockResolvedValue(undefined),
  uidNext: vi.fn().mockResolvedValue(1),
}));
vi.mock('../../../../src/nest/mail-ingest/imap.provider', () => ({
  ImapProvider: class {
    constructor(cfg: unknown) {
      ImapProviderCtor(cfg);
    }
    testConnection = testConnection;
    uidNext = uidNext;
  },
}));

const { dbPrepare } = vi.hoisted(() => ({ dbPrepare: vi.fn() }));
vi.mock('../../../../src/db/database', () => ({
  db: { prepare: dbPrepare },
  closeDb: () => {},
  reinitialize: () => {},
}));

// Off the real chain, same reasoning as mail-ingest.e2e.test.ts.
vi.mock('../../../../src/services/tripService', () => ({ createTrip: vi.fn(), generateDays: vi.fn() }));
vi.mock('../../../../src/services/reservationService', () => ({ resyncReservationDays: vi.fn() }));
vi.mock('../../../../src/nest/booking-import/booking-import.service', () => ({ BookingImportService: class {} }));

import { MailIngestService } from '../../../../src/nest/mail-ingest/mail-ingest.service';

const blockedError = 'Requests to private/internal network addresses are not allowed. Set ALLOW_INTERNAL_NETWORK=true to permit this for self-hosted setups.';
const blockedInput = { host: '169.254.169.254', username: 'me@example.com', password: 'hunter2' };

describe('MailIngestService SSRF guard (Fix 3)', () => {
  let svc: MailIngestService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new MailIngestService({} as unknown as BookingImportService);
  });

  it('addSource (save path): rejects a blocked host before ImapProvider ever connects, and persists nothing', async () => {
    checkSsrf.mockResolvedValue({ allowed: false, isPrivate: true, resolvedIp: '169.254.169.254', error: blockedError });

    await expect(svc.addSource(1, blockedInput)).rejects.toThrow(blockedError);

    expect(checkSsrf).toHaveBeenCalledWith('https://169.254.169.254:993');
    expect(ImapProviderCtor).not.toHaveBeenCalled();
    expect(testConnection).not.toHaveBeenCalled();
    expect(dbPrepare).not.toHaveBeenCalled(); // nothing written to mail_sources either
  });

  it('testConfig ("Test connection" path): rejects a blocked host before ImapProvider ever connects', async () => {
    checkSsrf.mockResolvedValue({ allowed: false, isPrivate: true, resolvedIp: '169.254.169.254', error: blockedError });

    const result = await svc.testConfig(blockedInput);

    expect(result).toEqual({ ok: false, error: blockedError });
    expect(checkSsrf).toHaveBeenCalledWith('https://169.254.169.254:993');
    expect(ImapProviderCtor).not.toHaveBeenCalled();
    expect(testConnection).not.toHaveBeenCalled();
  });

  it('checks the actual configured port, not just the default', async () => {
    checkSsrf.mockResolvedValue({ allowed: false, isPrivate: true, error: blockedError });

    await svc.testConfig({ ...blockedInput, port: 143 });

    expect(checkSsrf).toHaveBeenCalledWith('https://169.254.169.254:143');
  });

  it('does not leak the resolved IP into the user-facing error (only the guard message)', async () => {
    checkSsrf.mockResolvedValue({ allowed: false, isPrivate: true, resolvedIp: '169.254.169.254', error: blockedError });

    const result = await svc.testConfig(blockedInput);
    expect(result.error).toBe(blockedError);
    expect(result.error).not.toContain('169.254.169.254');
  });

  it('a public/allowed host still reaches ImapProvider normally (the guard does not block legitimate hosts)', async () => {
    checkSsrf.mockResolvedValue({ allowed: true, isPrivate: false, resolvedIp: '93.184.216.34' });
    dbPrepare.mockReturnValue({
      run: vi.fn().mockReturnValue({ lastInsertRowid: 7 }),
      get: vi.fn().mockReturnValue({
        id: 7, host: 'imap.example.com', port: 993, username: 'me@example.com',
        folder: 'INBOX', poll_interval_minutes: 60, enabled: 1, last_polled_at: null,
      }),
    });

    await svc.addSource(1, { host: 'imap.example.com', username: 'me@example.com', password: 'hunter2' });

    expect(checkSsrf).toHaveBeenCalledWith('https://imap.example.com:993');
    expect(ImapProviderCtor).toHaveBeenCalledTimes(1);
    expect(testConnection).toHaveBeenCalledTimes(1);
  });

  it('scheduled poll (runTick → pollSource): rejects a blocked host before ImapProvider ever connects, and never advances the cursor', async () => {
    checkSsrf.mockResolvedValue({ allowed: false, isPrivate: true, resolvedIp: '169.254.169.254', error: blockedError });
    const dueRow = {
      id: 5, user_id: 1, host: '169.254.169.254', port: 993, username: 'me@example.com',
      password_enc: 'enc', folder: 'INBOX', poll_interval_minutes: 60, enabled: 1, last_uid: 0, last_polled_at: null,
    };
    const updateRun = vi.fn();
    dbPrepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM mail_sources')) return { all: () => [dueRow] };
      if (sql.includes('UPDATE mail_sources')) return { run: updateRun };
      return { run: vi.fn(), get: vi.fn(), all: vi.fn() };
    });

    // runTick() swallows per-source failures (logs and moves on, see Fix 2's
    // per-source try/catch), so it resolves normally even though the one due
    // source was blocked — assert on the side effects instead of a rejection.
    await svc.runTick();

    expect(checkSsrf).toHaveBeenCalledWith('https://169.254.169.254:993');
    expect(ImapProviderCtor).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled(); // last_uid/last_polled_at never advanced — no poll actually happened
  });

  it('"Catch up": rejects a blocked host before ImapProvider ever connects', async () => {
    checkSsrf.mockResolvedValue({ allowed: false, isPrivate: true, resolvedIp: '169.254.169.254', error: blockedError });
    const sourceRow = {
      id: 9, user_id: 1, host: '169.254.169.254', port: 993, username: 'me@example.com',
      password_enc: 'enc', folder: 'INBOX', last_uid: 0,
    };
    dbPrepare.mockReturnValue({ get: vi.fn().mockReturnValue(sourceRow) });

    await expect(svc.catchUp(1, 9, 30)).rejects.toThrow(blockedError);

    expect(checkSsrf).toHaveBeenCalledWith('https://169.254.169.254:993');
    expect(ImapProviderCtor).not.toHaveBeenCalled();
  });
});
