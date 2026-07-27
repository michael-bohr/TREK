import { describe, it, expect } from 'vitest';
import { isBookingCandidate } from '../../../../src/nest/mail-ingest/candidate-filter';

describe('candidate-filter: isBookingCandidate', () => {
  it('passes a known travel sender domain', () => {
    expect(isBookingCandidate({ fromAddress: 'no-reply@aa.com', subject: 'Your trip', text: '' })).toBe(true);
  });

  it('passes a subdomain of a travel sender', () => {
    expect(isBookingCandidate({ fromAddress: 'confirmations@email.marriott.com' })).toBe(true);
  });

  it('passes on a flight number in the subject', () => {
    expect(isBookingCandidate({ fromAddress: 'x@unknown.test', subject: 'Confirmation AA100' })).toBe(true);
  });

  it('passes on a booking keyword in the body', () => {
    expect(isBookingCandidate({ fromAddress: 'x@unknown.test', subject: 'Booking', text: 'Your hotel check-in is at 3pm' })).toBe(true);
  });

  it('rejects a plain marketing newsletter', () => {
    expect(isBookingCandidate({ fromAddress: 'news@shop.example', subject: '50% off everything', text: 'Shop the sale now' })).toBe(false);
  });

  it('rejects an empty message from an unknown sender', () => {
    expect(isBookingCandidate({ fromAddress: 'a@b.test', subject: '', text: '' })).toBe(false);
  });
});
