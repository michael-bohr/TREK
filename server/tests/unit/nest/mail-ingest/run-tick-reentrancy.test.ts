/**
 * MailIngestService.runTick() re-entrancy guard (Fix 2).
 *
 * The scheduler cron fires every 5 minutes regardless of whether the previous
 * tick finished; a source with a backlog (IMAP fetch + kitinerary + an
 * optional LLM call + geocoding) can outlast that interval. Mirrors the
 * `running` flag idiom in server/src/services/airtrail/airtrailSync.ts: a
 * second concurrent call must return immediately without touching any source,
 * and the flag must be released in a `finally` so a thrown error can't wedge
 * it permanently.
 *
 * Uses a real temp SQLite db (same minimal schema as mail-ingest.e2e.test.ts)
 * and a fake ImapProvider whose first fetchNew() call blocks on a
 * test-controlled gate, so the two runTick() calls can be deterministically
 * overlapped instead of racing on real timing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BookingImportService } from '../../../../src/nest/booking-import/booking-import.service';

const { db } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const tmp = new Database(':memory:');
  tmp.exec('PRAGMA journal_mode = WAL');
  tmp.exec(`
    CREATE TABLE trips (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      title TEXT, start_date TEXT, end_date TEXT, is_archived INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE trip_members (trip_id INTEGER NOT NULL, user_id INTEGER NOT NULL);
    CREATE TABLE reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id INTEGER NOT NULL,
      type TEXT, confirmation_number TEXT);
    CREATE TABLE mail_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'imap',
      host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 993, username TEXT NOT NULL, password_enc TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT 'INBOX', poll_interval_minutes INTEGER NOT NULL DEFAULT 60,
      mode TEXT NOT NULL DEFAULT 'hybrid', enabled INTEGER NOT NULL DEFAULT 1, last_uid INTEGER,
      last_polled_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE mail_ingest_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, message_id TEXT NOT NULL,
      status TEXT NOT NULL, trip_id INTEGER, created_reservation_ids TEXT, error TEXT,
      subject TEXT, from_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE (source_id, message_id));
  `);
  return { db: tmp };
});
vi.mock('../../../../src/db/database', () => ({ db, closeDb: () => {}, reinitialize: () => {} }));

// Fake IMAP provider: fetchNew() counts calls and, on the first call, blocks
// on a gate the test controls — this is what lets us deterministically start
// tick 1, confirm it's genuinely in flight, then fire tick 2 on top of it.
const { fetchNewCalls, gate } = vi.hoisted(() => {
  let resolveGate: () => void = () => {};
  const state = {
    fetchNewCalls: { current: 0 },
    gate: {
      promise: new Promise<void>((resolve) => { resolveGate = resolve; }),
      release: () => resolveGate(),
    },
  };
  return state;
});
vi.mock('../../../../src/nest/mail-ingest/imap.provider', () => ({
  ImapProvider: class {
    async testConnection() {}
    async uidNext() { return 1; }
    async fetchNew() {
      fetchNewCalls.current++;
      if (fetchNewCalls.current === 1) await gate.promise; // block the first call only
      return [];
    }
    async scanSince() { return []; }
  },
}));

// Same reasoning as mail-ingest.e2e.test.ts: keep these off the real chain
// (adminService → mcp SDK) that importing the unmocked modules would pull in.
vi.mock('../../../../src/services/tripService', () => ({ createTrip: vi.fn(), generateDays: vi.fn() }));
vi.mock('../../../../src/services/reservationService', () => ({ resyncReservationDays: vi.fn() }));
vi.mock('../../../../src/services/notificationService', () => ({ send: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../../src/nest/booking-import/booking-import.service', () => ({ BookingImportService: class {} }));

import { MailIngestService } from '../../../../src/nest/mail-ingest/mail-ingest.service';

function insertDueSource(): number {
  const info = db
    .prepare(
      `INSERT INTO mail_sources (user_id, host, port, username, password_enc, folder, poll_interval_minutes, enabled, last_uid, last_polled_at)
       VALUES (1, 'imap.example.com', 993, 'me@example.com', 'enc', 'INBOX', 60, 1, 0, NULL)`,
    )
    .run();
  return Number(info.lastInsertRowid);
}

describe('MailIngestService.runTick() re-entrancy guard', () => {
  let svc: MailIngestService;

  beforeEach(() => {
    db.exec('DELETE FROM mail_sources; DELETE FROM mail_ingest_log;');
    fetchNewCalls.current = 0;
    svc = new MailIngestService({} as unknown as BookingImportService);
  });

  it('a second concurrent runTick() does not poll any source while the first is in flight', async () => {
    insertDueSource();

    const tick1 = svc.runTick(); // enters, selects the due source, calls fetchNew() → blocks on gate.promise

    // Let tick1's microtasks run up to the point where it's actually awaiting
    // fetchNew() inside the fake provider, so tick2 genuinely overlaps it.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchNewCalls.current).toBe(1); // tick1 is now blocked inside its one fetchNew() call

    const tick2 = svc.runTick(); // must see `running === true` and return immediately
    await tick2;
    expect(fetchNewCalls.current).toBe(1); // tick2 made zero progress — did not re-select/re-poll the source

    gate.release(); // let tick1 finish
    await tick1;
    expect(fetchNewCalls.current).toBe(1); // still just tick1's one call, start to finish
  });

  it('releases the flag in a finally so a throw does not wedge future ticks', async () => {
    insertDueSource();

    // Force the very first statement in runTick() (the "due sources" SELECT)
    // to throw, simulating an unexpected failure before any source is touched.
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
      throw new Error('boom: due-sources query failed');
    });

    await expect(svc.runTick()).rejects.toThrow('boom');
    prepareSpy.mockRestore();

    // The flag must not still read "true" after the throw — if it were left
    // set (no finally, or a finally that forgot to reset it), every future
    // tick would silently no-op forever with no error and no logs.
    expect((svc as unknown as { running: boolean }).running).toBe(false);

    // And a fresh tick actually does real work again — not silently skipped.
    const tick2 = svc.runTick();
    await tick2;
    expect(fetchNewCalls.current).toBe(1);
  });
});
