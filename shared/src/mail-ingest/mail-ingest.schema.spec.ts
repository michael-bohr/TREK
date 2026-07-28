import { mailIngestSourceEnabledSchema, mailIngestSourceSchema } from './mail-ingest.schema';

import { describe, it, expect } from 'vitest';

describe('mailIngestSourceSchema', () => {
  const valid = { host: 'imap.example.com', username: 'me@example.com', password: 'hunter2' };

  it('accepts a body with just the required credentials', () => {
    expect(mailIngestSourceSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts the optional fields when present', () => {
    const parsed = mailIngestSourceSchema.parse({
      ...valid,
      port: 143,
      folder: 'Archive',
      poll_interval_minutes: 15,
    });
    expect(parsed).toEqual({ ...valid, port: 143, folder: 'Archive', poll_interval_minutes: 15 });
  });

  it('leaves the optional fields undefined when omitted (service applies its own defaults)', () => {
    const parsed = mailIngestSourceSchema.parse(valid);
    expect(parsed.port).toBeUndefined();
    expect(parsed.folder).toBeUndefined();
    expect(parsed.poll_interval_minutes).toBeUndefined();
  });

  it('rejects a body missing host, username, or password', () => {
    expect(mailIngestSourceSchema.safeParse({ ...valid, host: undefined }).success).toBe(false);
    expect(mailIngestSourceSchema.safeParse({ ...valid, username: undefined }).success).toBe(false);
    expect(mailIngestSourceSchema.safeParse({ ...valid, password: undefined }).success).toBe(false);
  });

  it('rejects blank host/username but tolerates a blank folder (service treats it as omitted)', () => {
    expect(mailIngestSourceSchema.safeParse({ ...valid, host: '   ' }).success).toBe(false);
    expect(mailIngestSourceSchema.safeParse({ ...valid, username: '   ' }).success).toBe(false);
    expect(mailIngestSourceSchema.safeParse({ ...valid, folder: '' }).success).toBe(true);
  });

  it('rejects a port outside the valid TCP range', () => {
    expect(mailIngestSourceSchema.safeParse({ ...valid, port: 0 }).success).toBe(false);
    expect(mailIngestSourceSchema.safeParse({ ...valid, port: 70000 }).success).toBe(false);
    expect(mailIngestSourceSchema.safeParse({ ...valid, port: 993 }).success).toBe(true);
  });

  it('rejects a non-positive poll interval', () => {
    expect(mailIngestSourceSchema.safeParse({ ...valid, poll_interval_minutes: 0 }).success).toBe(false);
    expect(mailIngestSourceSchema.safeParse({ ...valid, poll_interval_minutes: -5 }).success).toBe(false);
  });
});

describe('mailIngestSourceEnabledSchema', () => {
  it('accepts a boolean or an omitted enabled field', () => {
    expect(mailIngestSourceEnabledSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(mailIngestSourceEnabledSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(mailIngestSourceEnabledSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a non-boolean enabled value', () => {
    expect(mailIngestSourceEnabledSchema.safeParse({ enabled: 'true' }).success).toBe(false);
    expect(mailIngestSourceEnabledSchema.safeParse({ enabled: 1 }).success).toBe(false);
  });
});
