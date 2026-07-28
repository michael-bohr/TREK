import { describe, it, expect, vi } from 'vitest';

const { getText } = vi.hoisted(() => ({ getText: vi.fn(async () => ({ text: 'Hotel X — confirmation ABC' })) }));
vi.mock('pdf-parse', () => ({
  PDFParse: class {
    getText = getText;
    destroy = vi.fn(async () => {});
  },
}));

import { isTextLike, isPdf, extractText } from '../../../../src/nest/llm-parse/text-extract';

describe('text-extract', () => {
  it('classifies text-like and pdf extensions', () => {
    expect(isTextLike('a.txt')).toBe(true);
    expect(isTextLike('a.html')).toBe(true);
    expect(isTextLike('a.eml')).toBe(true);
    expect(isTextLike('a.pdf')).toBe(false);
    expect(isPdf('a.PDF')).toBe(true);
    expect(isPdf('a.txt')).toBe(false);
  });

  it('decodes plain text', async () => {
    expect(await extractText(Buffer.from('hello world'), 'a.txt')).toBe('hello world');
  });

  it('strips markup from html/eml', async () => {
    const html = '<html><style>x{}</style><body><p>Flight AB123</p><script>1</script></body></html>';
    const out = await extractText(Buffer.from(html), 'a.html');
    expect(out).toContain('Flight AB123');
    expect(out).not.toContain('<p>');
    expect(out).not.toContain('x{}');
  });

  it('extracts the embedded text layer from a pdf', async () => {
    const out = await extractText(Buffer.from('%PDF-1.4'), 'a.pdf');
    expect(out).toBe('Hotel X — confirmation ABC');
    expect(getText).toHaveBeenCalled();
  });

  it('MIME-parses a forwarded .eml to the subject + message body, discarding SMTP/MIME headers', async () => {
    // A realistic forwarded booking email: a wall of Received/DKIM/ARC headers
    // ahead of a multipart/alternative body. Before the fix, extractText() ran
    // stripMarkup() on the raw buffer — which only strips HTML tags, so this
    // header block (none of it HTML) survives straight into the extracted text
    // and crowds the actual booking details out of the char budget.
    const eml = [
      'Received: from mail.example.com (mail.example.com [10.0.0.1])',
      '    by mx.google.com with ESMTPS id abc123',
      '    for <me@example.com>; Wed, 01 Jul 2026 10:00:00 -0700 (PDT)',
      'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com;',
      '    s=selector1; h=from:to:subject; bh=abcdef=; b=xyz123longsigdata==',
      'ARC-Seal: i=1; a=rsa-sha256; d=google.com; s=arc-20160816;',
      '    b=longarcsealdata==',
      'ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=google.com;',
      '    s=arc-20160816; h=from:to:subject; bh=abcdef=; b=longarcsigdata==',
      'From: "Booking.com" <noreply@booking.com>',
      'To: Traveler <me@example.com>',
      'Subject: Your booking confirmation ABC123',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="boundary123"',
      '',
      '--boundary123',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Your reservation at Hotel Amsterdam is confirmed.',
      'Check-in: 2026-08-01',
      'Confirmation number: ABC123',
      '',
      '--boundary123',
      'Content-Type: text/html; charset="UTF-8"',
      '',
      '<html><body><p>Your reservation at Hotel Amsterdam is confirmed.</p></body></html>',
      '',
      '--boundary123--',
      '',
    ].join('\r\n');

    const out = await extractText(Buffer.from(eml), 'booking.eml');
    expect(out).toContain('Hotel Amsterdam');
    expect(out).toContain('ABC123');
    expect(out).toContain('Subject: Your booking confirmation ABC123');
    expect(out).not.toContain('DKIM-Signature');
    expect(out).not.toContain('ARC-Seal');
    expect(out).not.toContain('Received:');
  });

  it('falls back to the raw decode if MIME parsing of an .eml yields nothing usable', async () => {
    const out = await extractText(Buffer.from(''), 'empty.eml');
    expect(out).toBe('');
  });
});
