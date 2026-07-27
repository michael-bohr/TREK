import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/**
 * Thin IMAP read adapter behind the `MailSource` interface. Stateless between
 * calls: each method connects, does its work inside a mailbox lock, and logs out
 * — polling, not a persistent IDLE connection (so it stays a cron tick, not a
 * daemon). An OAuth/Gmail provider or an inbound-webhook provider can implement
 * the same interface later without touching the ingest service.
 */

export interface MailSourceConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  folder: string;
}

export interface RawMessage {
  uid: number;
  messageId: string;
  fromAddress: string | null;
  subject: string | null;
  text: string | null; // plain-text body, for the candidate pre-filter
  eml: Buffer; // raw RFC822 message, handed to the booking extractor
}

export interface MailSource {
  testConnection(): Promise<void>;
  /** UID the next new message will get — used to seed the cursor on connect. */
  uidNext(): Promise<number>;
  /** New messages with UID strictly greater than `sinceUid` (capped). */
  fetchNew(sinceUid: number, cap?: number): Promise<RawMessage[]>;
  /** Backfill: messages received in the last `days` (capped). */
  scanSince(days: number, cap?: number): Promise<RawMessage[]>;
}

const DEFAULT_CAP = 50;
const MS_DAY = 86_400_000;

export class ImapProvider implements MailSource {
  constructor(private readonly cfg: MailSourceConfig) {}

  private newClient(): ImapFlow {
    return new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.port === 993,
      auth: { user: this.cfg.username, pass: this.cfg.password },
      logger: false,
      // Bound the handshake so a wrong host doesn't hang the tick.
      socketTimeout: 30_000,
    });
  }

  /** connect → run inside a mailbox lock → always log out. */
  private async withMailbox<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.newClient();
    await client.connect();
    try {
      const lock = await client.getMailboxLock(this.cfg.folder);
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  private async toRawMessage(uid: number, source: Buffer): Promise<RawMessage> {
    const parsed = await simpleParser(source);
    return {
      uid,
      messageId: parsed.messageId ?? `<no-id-${uid}@mail-ingest.local>`,
      fromAddress: parsed.from?.value?.[0]?.address ?? null,
      subject: parsed.subject ?? null,
      text: parsed.text ?? null,
      eml: source,
    };
  }

  private async fetchRange(
    client: ImapFlow,
    range: string,
    cap: number,
    minUidExclusive: number,
  ): Promise<RawMessage[]> {
    const out: RawMessage[] = [];
    for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
      // An `N:*` range always returns the latest message even when its UID < N.
      if (msg.uid <= minUidExclusive) continue;
      if (!msg.source) continue;
      out.push(await this.toRawMessage(msg.uid, msg.source as Buffer));
      if (out.length >= cap) break;
    }
    return out;
  }

  async testConnection(): Promise<void> {
    await this.withMailbox(async () => {});
  }

  async uidNext(): Promise<number> {
    return this.withMailbox(async (client) => Number(client.mailbox && client.mailbox.uidNext) || 1);
  }

  async fetchNew(sinceUid: number, cap = DEFAULT_CAP): Promise<RawMessage[]> {
    return this.withMailbox((client) => this.fetchRange(client, `${sinceUid + 1}:*`, cap, sinceUid));
  }

  async scanSince(days: number, cap = DEFAULT_CAP): Promise<RawMessage[]> {
    const since = new Date(Date.now() - days * MS_DAY);
    return this.withMailbox(async (client) => {
      const uids = (await client.search({ since }, { uid: true })) || [];
      const slice = uids.slice(-cap);
      if (slice.length === 0) return [];
      return this.fetchRange(client, slice.join(','), cap, 0);
    });
  }
}
