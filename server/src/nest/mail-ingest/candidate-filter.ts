import { detectType, detectFlightNumbers } from '../llm-parse/router/extraction-router';

/**
 * Cheap "is this a travel booking?" gate, run over every scanned message BEFORE
 * any parsing. Whole-inbox scanning would otherwise feed kitinerary (and, under
 * fallback-on-empty, the LLM) every newsletter and receipt; this keeps the
 * expensive work to messages that actually look like itineraries.
 *
 * Reuses the LLM router's own detectors (detectType / detectFlightNumbers) so the
 * pre-filter and the parser agree on what "travel" looks like — no parallel
 * keyword list to drift. A known travel sender domain is an additional fast path.
 */

// Registrable domains (matched as a suffix on the sender) for the common
// airlines / hotel chains / OTAs. Not exhaustive — the keyword/flight-number
// heuristics catch the long tail; this just shortcuts the obvious senders.
const TRAVEL_SENDER_DOMAINS = [
  // airlines
  'aa.com', 'united.com', 'delta.com', 'southwest.com', 'jetblue.com', 'alaskaair.com',
  'britishairways.com', 'lufthansa.com', 'airfrance.com', 'klm.com', 'ryanair.com',
  'easyjet.com', 'emirates.com', 'qatarairways.com', 'singaporeair.com', 'ana.co.jp',
  'jal.com', 'flyfrontier.com', 'spirit.com', 'aircanada.ca', 'iberia.com', 'swiss.com',
  // hotels / lodging
  'marriott.com', 'hilton.com', 'hyatt.com', 'ihg.com', 'accor.com', 'booking.com',
  'airbnb.com', 'expedia.com', 'hotels.com', 'agoda.com', 'vrbo.com', 'choicehotels.com',
  // rail / bus / car / OTAs
  'amtrak.com', 'bahn.de', 'sncf.com', 'trainline.com', 'flixbus.com', 'sixt.com',
  'hertz.com', 'avis.com', 'europcar.com', 'enterprise.com', 'kayak.com', 'tripit.com',
];

export interface CandidateInput {
  fromAddress?: string | null;
  subject?: string | null;
  text?: string | null;
}

function senderDomainMatches(fromAddress: string | null | undefined): boolean {
  if (!fromAddress) return false;
  const at = fromAddress.lastIndexOf('@');
  if (at < 0) return false;
  const domain = fromAddress.slice(at + 1).toLowerCase().replace(/[>\s]+$/, '');
  return TRAVEL_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** True when a message is worth parsing. Loose enough not to miss bookings,
 *  tight enough to skip the bulk of an inbox. */
export function isBookingCandidate(input: CandidateInput): boolean {
  if (senderDomainMatches(input.fromAddress)) return true;
  const hay = `${input.subject ?? ''}\n${input.text ?? ''}`;
  if (!hay.trim()) return false;
  if (detectType(hay)) return true;
  if (detectFlightNumbers(hay).length > 0) return true;
  return false;
}
