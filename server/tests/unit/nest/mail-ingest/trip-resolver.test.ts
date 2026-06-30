import { describe, it, expect } from 'vitest';
import { itemSpan, messageSpan, resolveMessage, type ResolverTrip } from '../../../../src/nest/mail-ingest/trip-resolver';
import type { ParsedBookingItem } from '../../../../src/nest/booking-import/kitinerary.types';

const flight = (over: Partial<ParsedBookingItem> = {}): ParsedBookingItem => ({
  type: 'flight',
  title: 'AA100 SEA → NRT',
  reservation_time: '2026-07-04T10:00',
  reservation_end_time: '2026-07-04T13:00',
  source: { fileName: 'msg', index: 0 },
  endpoints: [
    { role: 'from', sequence: 0, name: 'Seattle (SEA)', code: 'SEA', lat: null, lng: null, timezone: null, local_time: '10:00', local_date: '2026-07-04' },
    { role: 'to', sequence: 1, name: 'Tokyo (NRT)', code: 'NRT', lat: null, lng: null, timezone: null, local_time: '13:00', local_date: '2026-07-04' },
  ],
  ...over,
});

const hotel = (over: Partial<ParsedBookingItem> = {}): ParsedBookingItem => ({
  type: 'hotel',
  title: 'Hyatt Regency',
  source: { fileName: 'msg', index: 0 },
  _accommodation: { check_in: '2026-07-05', check_out: '2026-07-08' },
  ...over,
});

const restaurant = (over: Partial<ParsedBookingItem> = {}): ParsedBookingItem => ({
  type: 'restaurant',
  title: 'Sushi Saito',
  reservation_time: '2026-07-06T19:00',
  source: { fileName: 'msg', index: 0 },
  ...over,
});

const trip = (id: number, start: string, end: string): ResolverTrip => ({ id, start_date: start, end_date: end });

describe('trip-resolver: itemSpan', () => {
  it('reads a flight span from reservation times', () => {
    expect(itemSpan(flight())).toEqual({ start: '2026-07-04', end: '2026-07-04' });
  });
  it('reads a hotel span from _accommodation check-in/out', () => {
    expect(itemSpan(hotel())).toEqual({ start: '2026-07-05', end: '2026-07-08' });
  });
  it('returns null when an item has no usable date', () => {
    expect(itemSpan(flight({ reservation_time: null, reservation_end_time: null, endpoints: [] }))).toBeNull();
  });
});

describe('trip-resolver: messageSpan', () => {
  it('unions earliest start → latest end across items', () => {
    expect(messageSpan([flight(), hotel()])).toEqual({ start: '2026-07-04', end: '2026-07-08' });
  });
});

describe('trip-resolver: resolveMessage', () => {
  it('attaches to the single overlapping trip', () => {
    const res = resolveMessage([flight()], [trip(9, '2026-07-01', '2026-07-10')]);
    expect(res).toEqual({ action: 'attach', tripId: 9 });
  });

  it('creates a trip (titled by arrival city) when none matches and an item is trip-defining', () => {
    const res = resolveMessage([flight()], []);
    expect(res).toMatchObject({ action: 'create', title: 'Tokyo', span: { start: '2026-07-04', end: '2026-07-04' } });
  });

  it('is ambiguous when >1 trips overlap', () => {
    const res = resolveMessage([flight()], [trip(1, '2026-07-01', '2026-07-10'), trip(2, '2026-07-03', '2026-07-06')]);
    expect(res).toEqual({ action: 'ambiguous', reason: 'multiple matching trips' });
  });

  it('is ambiguous for an attach-only type with no matching trip (a dinner cannot create a trip)', () => {
    const res = resolveMessage([restaurant()], []);
    expect(res).toEqual({ action: 'ambiguous', reason: 'no trip and not trip-defining' });
  });

  it('is ambiguous when the message has no usable dates', () => {
    const res = resolveMessage([flight({ reservation_time: null, reservation_end_time: null, endpoints: [] })], []);
    expect(res).toEqual({ action: 'ambiguous', reason: 'no usable dates' });
  });

  it('honours the ±buffer so a flight a day before the trip still attaches', () => {
    // trip starts 2026-07-05; flight on 2026-07-04 is within the default ±2-day buffer
    const res = resolveMessage([flight()], [trip(7, '2026-07-05', '2026-07-12')]);
    expect(res).toEqual({ action: 'attach', tripId: 7 });
  });
});
