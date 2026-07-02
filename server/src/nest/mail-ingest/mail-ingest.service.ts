import { Injectable } from '@nestjs/common';
import type { BookingImportMode } from '@trek/shared';
import { db } from '../../db/database';
import { encrypt_api_key, decrypt_api_key } from '../../services/apiKeyCrypto';
import { createTrip } from '../../services/tripService';
import { broadcastToUser } from '../../websocket';
import { BookingImportService } from '../booking-import/booking-import.service';
import { ImapProvider, type RawMessage } from './imap.provider';
import { isBookingCandidate } from './candidate-filter';
import { resolveMessage, type ResolverTrip } from './trip-resolver';

/** Extraction mode for the auto path: kitinerary first, LLM only on what it
 *  can't read (degrades to kitinerary-only when no LLM is configured). */
const EXTRACT_MODE: BookingImportMode = 'fallback-on-empty';

interface SourceRow {
  id: number;
  user_id: number;
  host: string;
  port: number;
  username: string;
  password_enc: string;
  folder: string;
  poll_interval_minutes: number;
  mode: string;
  enabled: number;
  last_uid: number | null;
  last_polled_at: string | null;
}

export interface SafeSource {
  id: number;
  host: string;
  port: number;
  username: string;
  folder: string;
  poll_interval_minutes: number;
  mode: string;
  enabled: boolean;
  last_polled_at: string | null;
}

export interface MailSourceInput {
  host: string;
  port?: number;
  username: string;
  password: string;
  folder?: string;
  poll_interval_minutes?: number;
}

export interface IngestCounts {
  imported: number;
  pending: number;
  skipped: number;
  errored: number;
}

@Injectable()
export class MailIngestService {
  constructor(private readonly bookingImport: BookingImportService) {}

  // ── Source CRUD ─────────────────────────────────────────────────────────

  private toSafe(r: SourceRow): SafeSource {
    return {
      id: r.id,
      host: r.host,
      port: r.port,
      username: r.username,
      folder: r.folder,
      poll_interval_minutes: r.poll_interval_minutes,
      mode: r.mode,
      enabled: !!r.enabled,
      last_polled_at: r.last_polled_at,
    };
  }

  listSources(userId: number): SafeSource[] {
    const rows = db
      .prepare('SELECT * FROM mail_sources WHERE user_id = ? ORDER BY id')
      .all(userId) as SourceRow[];
    return rows.map((r) => this.toSafe(r));
  }

  private getRow(userId: number, id: number | string): SourceRow | undefined {
    return db
      .prepare('SELECT * FROM mail_sources WHERE id = ? AND user_id = ?')
      .get(id, userId) as SourceRow | undefined;
  }

  /** Validate the credentials and, on success, persist the source with its UID
   *  cursor seeded so the first tick only sees NEW mail (no history flood). */
  async addSource(userId: number, input: MailSourceInput): Promise<SafeSource> {
    const cfg = this.cfgFromInput(input);
    const provider = new ImapProvider(cfg);
    await provider.testConnection();
    const uidNext = await provider.uidNext();
    const info = db
      .prepare(
        `INSERT INTO mail_sources (user_id, host, port, username, password_enc, folder, poll_interval_minutes, last_uid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        cfg.host,
        cfg.port,
        cfg.username,
        encrypt_api_key(input.password),
        cfg.folder,
        input.poll_interval_minutes ?? 60,
        Math.max(0, uidNext - 1),
      );
    return this.toSafe(this.getRow(userId, Number(info.lastInsertRowid))!);
  }

  deleteSource(userId: number, id: number | string): boolean {
    return db.prepare('DELETE FROM mail_sources WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  setEnabled(userId: number, id: number | string, enabled: boolean): boolean {
    return (
      db
        .prepare('UPDATE mail_sources SET enabled = ? WHERE id = ? AND user_id = ?')
        .run(enabled ? 1 : 0, id, userId).changes > 0
    );
  }

  /** Test arbitrary credentials without saving (the "Test connection" button). */
  async testConfig(input: MailSourceInput): Promise<{ ok: boolean; error?: string }> {
    try {
      await new ImapProvider(this.cfgFromInput(input)).testConnection();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private cfgFromInput(input: MailSourceInput) {
    return {
      host: input.host.trim(),
      port: input.port ?? 993,
      username: input.username.trim(),
      password: input.password,
      folder: (input.folder || 'INBOX').trim(),
    };
  }

  private providerFor(source: SourceRow): ImapProvider {
    return new ImapProvider({
      host: source.host,
      port: source.port,
      username: source.username,
      password: String(decrypt_api_key(source.password_enc) ?? ''),
      folder: source.folder,
    });
  }

  // ── Ingestion ───────────────────────────────────────────────────────────

  /** Scheduler entrypoint: poll every enabled source whose interval has elapsed.
   *  Sources run sequentially; one bad mailbox never blocks the others. */
  async runTick(): Promise<void> {
    const due = db
      .prepare(
        `SELECT * FROM mail_sources
         WHERE enabled = 1
           AND (last_polled_at IS NULL
                OR last_polled_at <= datetime('now', '-' || poll_interval_minutes || ' minutes'))
         ORDER BY id`,
      )
      .all() as SourceRow[];
    for (const source of due) {
      try {
        await this.pollSource(source);
      } catch (err) {
        console.error(`[mail-ingest] source ${source.id} poll failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private async pollSource(source: SourceRow): Promise<IngestCounts> {
    const provider = this.providerFor(source);
    const sinceUid = source.last_uid ?? Math.max(0, (await provider.uidNext()) - 1);
    const messages = await provider.fetchNew(sinceUid);
    const counts = await this.ingestMessages(source, messages);
    // Advance the cursor past everything we saw (candidates and non-candidates)
    // so non-bookings are never re-fetched.
    const maxUid = messages.reduce((m, msg) => Math.max(m, msg.uid), sinceUid);
    db.prepare('UPDATE mail_sources SET last_uid = ?, last_polled_at = CURRENT_TIMESTAMP WHERE id = ?').run(maxUid, source.id);
    return counts;
  }

  /** On-demand backfill of the last `days` (the "Catch up" button). */
  async catchUp(userId: number, sourceId: number | string, days: number): Promise<IngestCounts> {
    const source = this.getRow(userId, sourceId);
    if (!source) throw new Error('Mail source not found');
    const messages = await this.providerFor(source).scanSince(days);
    const counts = await this.ingestMessages(source, messages);
    // Record the check (so the UI shows "last checked") and advance the cursor past
    // what we scanned so the next tick won't re-fetch it (dedupe covers re-runs anyway).
    const maxUid = messages.reduce((m, msg) => Math.max(m, msg.uid), source.last_uid ?? 0);
    db.prepare('UPDATE mail_sources SET last_uid = ?, last_polled_at = CURRENT_TIMESTAMP WHERE id = ?').run(maxUid, source.id);
    return counts;
  }

  private async ingestMessages(source: SourceRow, messages: RawMessage[]): Promise<IngestCounts> {
    const counts: IngestCounts = { imported: 0, pending: 0, skipped: 0, errored: 0 };
    const trips = this.userTrips(source.user_id);
    for (const msg of messages) {
      try {
        const status = await this.ingestOne(source, msg, trips);
        counts[status]++;
      } catch (err) {
        counts.errored++;
        this.log(source.id, msg.messageId, 'error', null, null, err instanceof Error ? err.message : String(err));
        console.error(`[mail-ingest] message ${msg.messageId} failed:`, err instanceof Error ? err.message : err);
      }
    }
    return counts;
  }

  private async ingestOne(
    source: SourceRow,
    msg: RawMessage,
    trips: ResolverTrip[],
  ): Promise<'imported' | 'pending' | 'skipped'> {
    // Already processed this message for this source.
    if (this.seen(source.id, msg.messageId)) return 'skipped';

    // Cheap gate: skip non-bookings without parsing (and without logging — they
    // get re-filtered cheaply on a future catch-up).
    if (!isBookingCandidate({ fromAddress: msg.fromAddress, subject: msg.subject, text: msg.text })) {
      return 'skipped';
    }

    const file = { buffer: msg.eml, originalname: 'message.eml' } as unknown as Express.Multer.File;
    const { items } = await this.bookingImport.preview([file], EXTRACT_MODE, source.user_id);

    if (items.length === 0) {
      this.log(source.id, msg.messageId, 'skipped', null, null);
      return 'skipped';
    }

    const resolution = resolveMessage(items, trips);

    // Genuinely nothing to persist yet: no usable dates, or the trip can't be
    // determined (0 or >1 candidates). Everything else has a known trip.
    if (resolution.action === 'ambiguous') {
      this.log(source.id, msg.messageId, 'pending', null, null, resolution.reason);
      this.notify(source.user_id, { status: 'pending', subject: msg.subject, reason: resolution.reason });
      return 'pending';
    }

    let tripId: number;
    if (resolution.action === 'create') {
      const created = createTrip(source.user_id, {
        title: resolution.title,
        start_date: resolution.span.start,
        end_date: resolution.span.end,
      });
      tripId = created.tripId;
      // Make the new trip visible to later messages in this same batch.
      trips.push({ id: tripId, start_date: resolution.span.start, end_date: resolution.span.end });
    } else {
      tripId = resolution.tripId;
    }

    // Persist unconditionally, same as AirTrail's unattended sync: needs_review
    // (LLM-derived, or kitinerary's own field-completeness flags) rides along on
    // the reservation as the existing review badge, not a gate on saving at all.
    const { created } = await this.bookingImport.confirm(String(tripId), items, undefined);
    if (created.length === 0) {
      // confirm() swallows per-item persistence errors internally and still
      // resolves — nothing was actually written despite not throwing. Surface
      // it as a real failure (logged 'error', retried on a later tick) instead
      // of falsely claiming 'imported' with an empty result.
      throw new Error(`confirm() created 0 of ${items.length} reservation(s) — see server logs for the per-item error`);
    }
    const needsReview = items.some((it) => it.needs_review);
    this.log(source.id, msg.messageId, 'imported', tripId, created.map((r) => r.id));
    this.notify(source.user_id, { status: 'imported', tripId, count: created.length, subject: msg.subject, needsReview });
    return 'imported';
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private userTrips(userId: number): ResolverTrip[] {
    return db
      .prepare(
        `SELECT DISTINCT t.id, t.start_date, t.end_date
         FROM trips t
         LEFT JOIN trip_members m ON m.trip_id = t.id
         WHERE (t.user_id = ? OR m.user_id = ?) AND t.is_archived = 0`,
      )
      .all(userId, userId) as ResolverTrip[];
  }

  /** 'pending'/'error' are not terminal — nothing was persisted, so a later tick
   *  (new trip created, transient failure gone) should get another attempt.
   *  Only 'imported'/'skipped' are done-for-good. */
  private seen(sourceId: number, messageId: string): boolean {
    return !!db
      .prepare("SELECT 1 FROM mail_ingest_log WHERE source_id = ? AND message_id = ? AND status IN ('imported', 'skipped')")
      .get(sourceId, messageId);
  }

  private log(
    sourceId: number,
    messageId: string,
    status: string,
    tripId: number | null,
    reservationIds: number[] | null,
    error?: string,
  ): void {
    db.prepare(
      `INSERT INTO mail_ingest_log (source_id, message_id, status, trip_id, created_reservation_ids, error)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, message_id) DO UPDATE SET
         status = excluded.status, trip_id = excluded.trip_id,
         created_reservation_ids = excluded.created_reservation_ids, error = excluded.error`,
    ).run(sourceId, messageId, status, tripId, reservationIds ? JSON.stringify(reservationIds) : null, error ?? null);
  }

  private notify(userId: number, payload: Record<string, unknown>): void {
    try {
      broadcastToUser(userId, { type: 'mail-ingest', ...payload });
    } catch {
      /* best-effort */
    }
  }
}
