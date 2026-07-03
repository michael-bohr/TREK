/**
 * Mail-ingest e2e — drives MailIngestService end-to-end against a temp in-memory
 * SQLite db with a FAKE IMAP provider (canned messages) and a MOCKED
 * BookingImportService (so no kitinerary/LLM). Exercises the real candidate
 * filter, trip-resolver, dedupe and persistence wiring:
 *   - a flight email with no matching trip → creates a trip and auto-files it
 *   - the same message a second time → deduped (skipped), no re-import
 *   - a non-booking newsletter → skipped without ever parsing
 *   - a flight that overlaps an existing trip → attaches to it
 *   - a needs_review (LLM-derived) item still gets persisted, not stuck pending
 *   - an item with no usable dates stays pending, since no trip can be picked
 *   - a pending message is retried (not dedupe-blocked) once it can resolve
 *   - subject/from land on the log and listActivity is scoped to the owner
 *   - import/pending each fire the matching in-app notification event
 *   - per-passenger duplicate items collapse to one import
 *   - an attached booking past the trip's edge stretches the trip's dates
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { BookingImportService } from '../../src/nest/booking-import/booking-import.service';

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
vi.mock('../../src/db/database', () => ({ db, closeDb: () => {}, reinitialize: () => {} }));

// Fake IMAP provider: scanSince/fetchNew return whatever the test queued.
const { queued } = vi.hoisted(() => ({ queued: { current: [] as unknown[] } }));
vi.mock('../../src/nest/mail-ingest/imap.provider', () => ({
  ImapProvider: class {
    async testConnection() {}
    async uidNext() { return 1; }
    async fetchNew() { return queued.current; }
    async scanSince() { return queued.current; }
  },
}));

// tripService: createTrip on the "create" path; generateDays when an attach
// extends the trip span (day-grid work is out of scope for this harness).
const { createTrip, generateDays } = vi.hoisted(() => ({
  createTrip: vi.fn(() => ({ tripId: 999 })),
  generateDays: vi.fn(),
}));
vi.mock('../../src/services/tripService', () => ({ createTrip, generateDays }));
vi.mock('../../src/services/reservationService', () => ({ resyncReservationDays: vi.fn() }));

// In-app notifications: mock send() so the fire-and-forget dynamic import in
// notify() resolves here (vitest intercepts dynamic imports too) and the tests
// can assert what was sent.
const { send } = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/services/notificationService', () => ({ send }));

// Stub the booking-import service (we inject a mock) so importing the ingest
// service doesn't pull the real one's chain (adminService → mcp SDK) into vitest.
vi.mock('../../src/nest/booking-import/booking-import.service', () => ({ BookingImportService: class {} }));

import { MailIngestService } from '../../src/nest/mail-ingest/mail-ingest.service';

const eml = (s: string) => Buffer.from(s);
const flightMsg = {
  uid: 10,
  messageId: '<flight-1@test>',
  fromAddress: 'noreply@aa.com',
  subject: 'Your flight AA100 confirmation',
  text: 'AA100 SEA → NRT',
  eml: eml('raw-flight'),
};
const newsletterMsg = {
  uid: 11,
  messageId: '<news-1@test>',
  fromAddress: 'news@shop.example',
  subject: '50% off everything this weekend',
  text: 'Shop the sale now',
  eml: eml('raw-news'),
};
const flightItem = {
  type: 'flight',
  title: 'AA100 SEA → NRT',
  reservation_time: '2026-07-04T10:00',
  reservation_end_time: '2026-07-04T13:00',
  source: { fileName: 'message.eml', index: 0 },
  endpoints: [
    { role: 'from', sequence: 0, name: 'Seattle (SEA)', code: 'SEA', lat: null, lng: null, timezone: null, local_time: '10:00', local_date: '2026-07-04' },
    { role: 'to', sequence: 1, name: 'Tokyo (NRT)', code: 'NRT', lat: null, lng: null, timezone: null, local_time: '13:00', local_date: '2026-07-04' },
  ],
};

describe('Mail-ingest e2e (fake provider + temp SQLite)', () => {
  const preview = vi.fn();
  const confirm = vi.fn();
  let svc: MailIngestService;
  let sourceId: number;

  beforeAll(() => {
    svc = new MailIngestService({ preview, confirm } as unknown as BookingImportService);
  });

  beforeEach(async () => {
    db.exec('DELETE FROM trips; DELETE FROM trip_members; DELETE FROM mail_sources; DELETE FROM mail_ingest_log;');
    preview.mockReset();
    confirm.mockReset().mockResolvedValue({ created: [{ id: 1 }] });
    createTrip.mockClear().mockReturnValue({ tripId: 999 });
    generateDays.mockClear();
    send.mockClear();
    queued.current = [];
    const src = await svc.addSource(1, { host: 'imap.test', username: 'u@test', password: 'pw' });
    sourceId = src.id;
  });

  const rows = () => db.prepare('SELECT status, trip_id FROM mail_ingest_log').all() as { status: string; trip_id: number | null }[];

  it('creates a trip and auto-files a flight when none matches', async () => {
    preview.mockResolvedValue({ items: [flightItem], warnings: [], files: [] });
    queued.current = [flightMsg];

    const counts = await svc.catchUp(1, sourceId, 30);

    expect(counts).toMatchObject({ imported: 1, pending: 0, skipped: 0, errored: 0 });
    expect(createTrip).toHaveBeenCalledWith(1, expect.objectContaining({ title: 'Tokyo', start_date: '2026-07-04', end_date: '2026-07-04' }));
    expect(confirm).toHaveBeenCalledWith('999', [flightItem], undefined);
    expect(rows()).toEqual([{ status: 'imported', trip_id: 999 }]);
  });

  it('dedupes a re-sent message (no second import)', async () => {
    preview.mockResolvedValue({ items: [flightItem], warnings: [], files: [] });
    queued.current = [flightMsg];
    await svc.catchUp(1, sourceId, 30);
    confirm.mockClear();

    const counts = await svc.catchUp(1, sourceId, 30);
    expect(counts).toMatchObject({ imported: 0, skipped: 1 });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('skips a non-booking newsletter without parsing it', async () => {
    queued.current = [newsletterMsg];
    const counts = await svc.catchUp(1, sourceId, 30);
    expect(counts).toMatchObject({ imported: 0, skipped: 1 });
    expect(preview).not.toHaveBeenCalled();
  });

  it('attaches to an existing overlapping trip instead of creating one', async () => {
    db.prepare('INSERT INTO trips (id, user_id, start_date, end_date) VALUES (42, 1, ?, ?)').run('2026-07-01', '2026-07-10');
    preview.mockResolvedValue({ items: [flightItem], warnings: [], files: [] });
    queued.current = [flightMsg];

    const counts = await svc.catchUp(1, sourceId, 30);

    expect(counts).toMatchObject({ imported: 1 });
    expect(createTrip).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith('42', [flightItem], undefined);
    expect(rows()).toEqual([{ status: 'imported', trip_id: 42 }]);
  });

  it('imports a needs_review (LLM-derived) item instead of leaving it unpersisted', async () => {
    // Every LLM-extracted item is flagged needs_review regardless of completeness
    // (booking-import.service.ts) — that must not block persistence. It's the
    // same "persist + badge" pattern AirTrail sync already uses.
    const reviewItem = { ...flightItem, needs_review: true };
    preview.mockResolvedValue({ items: [reviewItem], warnings: [], files: [] });
    queued.current = [flightMsg];

    const counts = await svc.catchUp(1, sourceId, 30);

    expect(counts).toMatchObject({ imported: 1, pending: 0 });
    expect(confirm).toHaveBeenCalledWith('999', [reviewItem], undefined);
    expect(rows()).toEqual([{ status: 'imported', trip_id: 999 }]);
  });

  it('treats a silent confirm() failure (created:[]) as an error, not a false imported', async () => {
    // confirm() catches per-item persistence errors internally and still resolves
    // — reproduced live by a missing DB column that made createReservation() throw
    // inside confirm()'s own try/catch, so nothing was created but nothing threw.
    preview.mockResolvedValue({ items: [flightItem], warnings: [], files: [] });
    confirm.mockResolvedValue({ created: [] });
    queued.current = [flightMsg];

    const counts = await svc.catchUp(1, sourceId, 30);

    expect(counts).toMatchObject({ imported: 0, errored: 1 });
    expect(rows()).toEqual([{ status: 'error', trip_id: null }]);

    // And it must retry on a later catch-up rather than staying stuck.
    confirm.mockResolvedValue({ created: [{ id: 1 }] });
    const retry = await svc.catchUp(1, sourceId, 30);
    expect(retry).toMatchObject({ imported: 1, errored: 0 });
  });

  it('leaves an item with no usable dates pending instead of guessing a trip', async () => {
    const undated = { ...flightItem, reservation_time: undefined, reservation_end_time: undefined, endpoints: [] };
    preview.mockResolvedValue({ items: [undated], warnings: [], files: [] });
    queued.current = [flightMsg];

    const counts = await svc.catchUp(1, sourceId, 30);

    expect(counts).toMatchObject({ imported: 0, pending: 1 });
    expect(confirm).not.toHaveBeenCalled();
    expect(createTrip).not.toHaveBeenCalled();
    expect(rows()).toEqual([{ status: 'pending', trip_id: null }]);
  });

  it('retries a pending message on a later catch-up instead of dedupe-blocking it forever', async () => {
    // Attach-only type (not flight/hotel) with no matching trip yet → ambiguous/pending.
    const carItem = { ...flightItem, type: 'car', title: 'Rental car pickup' };
    preview.mockResolvedValue({ items: [carItem], warnings: [], files: [] });
    queued.current = [flightMsg];

    const first = await svc.catchUp(1, sourceId, 30);
    expect(first).toMatchObject({ imported: 0, pending: 1 });
    expect(rows()).toEqual([{ status: 'pending', trip_id: null }]);

    // A trip that overlaps the item's dates now exists.
    db.prepare('INSERT INTO trips (id, user_id, start_date, end_date) VALUES (7, 1, ?, ?)').run('2026-07-01', '2026-07-10');

    const second = await svc.catchUp(1, sourceId, 30);
    expect(second).toMatchObject({ imported: 1, pending: 0 });
    expect(confirm).toHaveBeenCalledWith('7', [carItem], undefined);
    expect(rows()).toEqual([{ status: 'imported', trip_id: 7 }]);
  });

  it('collapses per-passenger duplicates so a 5-seat e-ticket imports once', async () => {
    // Schema.org emits one FlightReservation per traveler on the same booking.
    preview.mockResolvedValue({ items: [flightItem, { ...flightItem }, { ...flightItem }, { ...flightItem }, { ...flightItem }], warnings: [], files: [] });
    queued.current = [flightMsg];

    const counts = await svc.catchUp(1, sourceId, 30);

    expect(counts).toMatchObject({ imported: 1 });
    expect(confirm).toHaveBeenCalledWith('999', [flightItem], undefined);
  });

  it('extends the trip span when an attached booking reaches past its edge', async () => {
    db.prepare('INSERT INTO trips (id, user_id, start_date, end_date) VALUES (42, 1, ?, ?)').run('2026-07-01', '2026-07-10');
    // Flight Jul 11 → 12: inside the ±2-day attach buffer, but past end_date.
    const lateFlight = {
      ...flightItem,
      reservation_time: '2026-07-11T10:00',
      reservation_end_time: '2026-07-12T13:00',
    };
    preview.mockResolvedValue({ items: [lateFlight], warnings: [], files: [] });
    queued.current = [flightMsg];

    const counts = await svc.catchUp(1, sourceId, 30);

    expect(counts).toMatchObject({ imported: 1 });
    expect(createTrip).not.toHaveBeenCalled();
    const trip = db.prepare('SELECT start_date, end_date FROM trips WHERE id = 42').get();
    expect(trip).toEqual({ start_date: '2026-07-01', end_date: '2026-07-12' });
    expect(generateDays).toHaveBeenCalledWith(42, '2026-07-01', '2026-07-12');
  });

  // notify() fires send() behind a dynamic import — flush microtasks/timers so
  // the fire-and-forget call has landed before asserting on the mock.
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('records subject/from on the log and exposes them via listActivity, owner-scoped', async () => {
    db.prepare("INSERT INTO trips (id, user_id, title, start_date, end_date) VALUES (42, 1, 'Japan', ?, ?)").run('2026-07-01', '2026-07-10');
    preview.mockResolvedValue({ items: [flightItem], warnings: [], files: [] });
    queued.current = [flightMsg];
    await svc.catchUp(1, sourceId, 30);

    const logRow = db.prepare('SELECT subject, from_address FROM mail_ingest_log').get();
    expect(logRow).toEqual({ subject: 'Your flight AA100 confirmation', from_address: 'noreply@aa.com' });

    const mine = svc.listActivity(1, 20);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      status: 'imported',
      subject: 'Your flight AA100 confirmation',
      from_address: 'noreply@aa.com',
      trip_id: 42,
      trip_title: 'Japan',
      reservation_count: 1,
      source_username: 'u@test',
    });

    // Another user sees none of it.
    await svc.addSource(2, { host: 'imap.test', username: 'other@test', password: 'pw' });
    expect(svc.listActivity(2, 20)).toEqual([]);
  });

  it('sends an in-app notification on import (→ trip) and on pending (→ review)', async () => {
    db.prepare("INSERT INTO trips (id, user_id, title, start_date, end_date) VALUES (42, 1, 'Japan', ?, ?)").run('2026-07-01', '2026-07-10');
    preview.mockResolvedValue({ items: [flightItem], warnings: [], files: [] });
    queued.current = [flightMsg];
    await svc.catchUp(1, sourceId, 30);
    await flush();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mail_ingest_imported',
        scope: 'user',
        targetId: 1,
        params: expect.objectContaining({ tripId: '42', trip: 'Japan', subject: 'Your flight AA100 confirmation', count: '1' }),
      }),
    );

    // A second, undated message defers → pending notification with the reason.
    send.mockClear();
    const undated = { ...flightItem, reservation_time: undefined, reservation_end_time: undefined, endpoints: [] };
    preview.mockResolvedValue({ items: [undated], warnings: [], files: [] });
    queued.current = [{ ...flightMsg, uid: 12, messageId: '<flight-2@test>' }];
    await svc.catchUp(1, sourceId, 30);
    await flush();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mail_ingest_pending',
        scope: 'user',
        targetId: 1,
        params: expect.objectContaining({ reason: 'no usable dates' }),
      }),
    );
  });
});
