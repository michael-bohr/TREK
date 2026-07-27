import type { BookingImportPreviewItem } from '@trek/shared';

/**
 * Decides which trip a forwarded booking belongs to — pure, no DB, no side
 * effects, so it unit-tests without IMAP or SQLite. The MailIngestService feeds
 * it the user's trips and the parsed items; it returns a placement decision and
 * the service performs the create/attach.
 */

export interface ResolverTrip {
  id: number;
  start_date: string | null;
  end_date: string | null;
}

export interface DateSpan {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD, >= start
}

export type Resolution =
  | { action: 'attach'; tripId: number }
  | { action: 'create'; span: DateSpan; title: string }
  | { action: 'ambiguous'; reason: string };

/** Only these may spin up a NEW trip; everything else attaches to an existing one. */
export const TRIP_DEFINING = new Set(['flight', 'hotel']);
const MS_DAY = 86_400_000;

function dateOf(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1] : null;
}

/** YYYY-MM-DD span for one parsed item, from whichever fields carry its dates. */
export function itemSpan(item: BookingImportPreviewItem): DateSpan | null {
  // Hotels carry their dates on _accommodation, not reservation_time.
  if (item._accommodation?.check_in) {
    const start = dateOf(item._accommodation.check_in);
    if (!start) return null;
    return { start, end: dateOf(item._accommodation.check_out) ?? start };
  }
  const fromEp = item.endpoints?.find((e) => e.role === 'from')?.local_date ?? null;
  const toEp = [...(item.endpoints ?? [])].reverse().find((e) => e.role === 'to')?.local_date ?? null;
  const start = dateOf(item.reservation_time) ?? dateOf(fromEp);
  if (!start) return null;
  return { start, end: dateOf(item.reservation_end_time) ?? dateOf(toEp) ?? start };
}

/**
 * Collapse duplicate items within one message. Schema.org (and kitinerary)
 * emit one reservation PER PASSENGER, so a 5-seat e-ticket arrives as five
 * identical flights — a human skips the copies in the manual preview, the
 * auto path must do it itself. Keyed on what makes a booking distinct; the
 * first occurrence wins.
 */
export function dedupeItems(items: BookingImportPreviewItem[]): BookingImportPreviewItem[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const key = JSON.stringify([
      it.type,
      it.title,
      it.confirmation_number ?? null,
      it.reservation_time ?? null,
      it.reservation_end_time ?? null,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Union span across a message's items (earliest start → latest end). */
export function messageSpan(items: BookingImportPreviewItem[]): DateSpan | null {
  const spans = items.map(itemSpan).filter((s): s is DateSpan => !!s);
  if (spans.length === 0) return null;
  const start = [...spans].sort((a, b) => a.start.localeCompare(b.start))[0].start;
  const end = [...spans].sort((a, b) => b.end.localeCompare(a.end))[0].end;
  return { start, end };
}

function overlaps(span: DateSpan, trip: ResolverTrip, bufferDays: number): boolean {
  if (!trip.start_date) return false;
  const ts = Date.parse(`${trip.start_date}T00:00:00Z`);
  const te = Date.parse(`${trip.end_date ?? trip.start_date}T00:00:00Z`);
  const ss = Date.parse(`${span.start}T00:00:00Z`);
  const se = Date.parse(`${span.end}T00:00:00Z`);
  if ([ts, te, ss, se].some((n) => Number.isNaN(n))) return false;
  const buf = bufferDays * MS_DAY;
  return ss <= te + buf && se >= ts - buf;
}

function destinationTitle(items: BookingImportPreviewItem[], span: DateSpan): string {
  // Prefer a flight's arrival city, else a hotel's city/venue.
  for (const it of items) {
    if (it.type === 'flight') {
      const to = [...(it.endpoints ?? [])].reverse().find((e) => e.role === 'to');
      if (to?.name) return to.name.replace(/\s*\([A-Z]{3}\)\s*$/, '').trim();
    }
  }
  for (const it of items) {
    if (it.type === 'hotel') {
      const city = it._venue?.address?.split(',')[1]?.trim() || it.location || it._venue?.name;
      if (city) return String(city);
    }
  }
  const month = new Date(`${span.start}T00:00:00Z`).toLocaleString('en', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `Trip — ${month}`;
}

/**
 * - exactly one overlapping trip → attach
 * - none + a trip-defining item (flight/hotel) → create
 * - none + only attach-only types → ambiguous (can't place without a trip)
 * - >1 overlapping trips, or no usable dates → ambiguous
 */
export function resolveMessage(
  items: BookingImportPreviewItem[],
  trips: ResolverTrip[],
  bufferDays = 2,
): Resolution {
  const span = messageSpan(items);
  if (!span) return { action: 'ambiguous', reason: 'no usable dates' };

  const candidates = trips.filter((t) => overlaps(span, t, bufferDays));
  if (candidates.length === 1) return { action: 'attach', tripId: candidates[0].id };
  if (candidates.length > 1) return { action: 'ambiguous', reason: 'multiple matching trips' };

  if (items.some((it) => TRIP_DEFINING.has(it.type))) {
    return { action: 'create', span, title: destinationTitle(items, span) };
  }
  return { action: 'ambiguous', reason: 'no trip and not trip-defining' };
}
