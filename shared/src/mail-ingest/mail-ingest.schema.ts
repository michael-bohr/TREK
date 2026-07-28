import { z } from 'zod';

/**
 * Mail-ingest IMAP source contracts — per-user mailbox polling config
 * (Settings → Integrations → mail ingest). `host`/`username`/`password` are
 * the credentials required to open a connection; `port`/`folder`/
 * `poll_interval_minutes` are optional and fall back to the service's own
 * defaults (993 / 'INBOX' / 60, see MailIngestService.cfgFromInput/addSource)
 * when omitted. `folder` deliberately allows an empty string through — the
 * service already treats a blank folder the same as "omitted" — so this
 * schema only rejects genuinely wrong shapes, not values the service itself
 * normalises.
 */
export const mailIngestSourceSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1),
  folder: z.string().max(255).optional(),
  poll_interval_minutes: z.number().int().positive().optional(),
});
export type MailIngestSourceInput = z.infer<typeof mailIngestSourceSchema>;

/** PATCH sources/:id — the only mutable field is the enabled toggle. */
export const mailIngestSourceEnabledSchema = z.object({
  enabled: z.boolean().optional(),
});
export type MailIngestSourceEnabled = z.infer<typeof mailIngestSourceEnabledSchema>;
