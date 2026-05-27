import { describe, expect, it } from 'vitest';
import { scrub, scrubString } from './scrub.js';

// PII scrubber. These tests double as a spec for what the gateway WILL
// redact pre-LLM and what it WILL pass through. Adjustments here directly
// shift the compliance posture; review with care.

describe('scrubString — single field', () => {
  it('redacts a plain email', () => {
    expect(scrubString('contact me at jane.doe@example.com please')).toBe(
      'contact me at [REDACTED:email] please',
    );
  });

  it('redacts multiple emails in one string', () => {
    const out = scrubString('cc a@b.com and c@d.io');
    expect(out).toBe('cc [REDACTED:email] and [REDACTED:email]');
  });

  it('redacts a US phone number with parens and dashes', () => {
    expect(scrubString('call +1 (415) 555-1234 today')).toBe(
      'call [REDACTED:phone] today',
    );
  });

  it('redacts an SSN in ###-##-#### format', () => {
    expect(scrubString('SSN 123-45-6789 on file')).toBe(
      'SSN [REDACTED:ssn] on file',
    );
  });

  it('does NOT redact a bare 9-digit number (too ambiguous)', () => {
    // Order numbers, invoice IDs, and many other things are 9 digits.
    // SSN matcher requires explicit dashes — false-positive cost is too
    // high otherwise. This is the intended behaviour.
    expect(scrubString('order 123456789 shipped')).toBe('order 123456789 shipped');
  });

  it('redacts a 16-digit credit card with 4-4-4-4 spaces', () => {
    expect(scrubString('card 4111 1111 1111 1111 on file')).toBe(
      'card [REDACTED:credit_card] on file',
    );
  });

  it('redacts a credit card with 4-4-4-4 dashes', () => {
    expect(scrubString('card 4111-1111-1111-1111')).toBe(
      'card [REDACTED:credit_card]',
    );
  });

  it('redacts an IBAN', () => {
    expect(scrubString('wire to GB29NWBK60161331926819 monday')).toBe(
      'wire to [REDACTED:iban] monday',
    );
  });

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJ0ZW5hbnRfaWQiOiJhYmMiLCJzdWIiOiJ4eXoifQ.signature123';
    expect(scrubString(`token ${jwt} valid`)).toBe('token [REDACTED:jwt] valid');
  });

  it('redacts known API key prefixes (sk_live, AIza, ghp_, xoxb-)', () => {
    expect(scrubString('key sk_live_abcdefghij1234567890')).toContain('[REDACTED:api_key]');
    expect(scrubString('key AIzaSyD0123456789abcdefghijklmnopqrstuvw')).toContain(
      '[REDACTED:api_key]',
    );
    expect(scrubString('key ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toContain(
      '[REDACTED:api_key]',
    );
    expect(scrubString('key xoxb-1234567890-abcdef')).toContain('[REDACTED:api_key]');
  });

  it('passes through strings with no PII unchanged', () => {
    const safe = 'The quarterly numbers came in higher than the agent forecast.';
    expect(scrubString(safe)).toBe(safe);
  });

  it('passes through structurally similar but invalid email-like strings', () => {
    // A floating '@' without a domain TLD is not an email — we don't
    // want to over-redact and hide legitimate user-facing content.
    expect(scrubString('the @mention in chat')).toBe('the @mention in chat');
  });
});

describe('scrub — recursive payload', () => {
  it('walks nested objects and arrays', () => {
    const input = {
      to: 'jane@example.com',
      cc: ['bob@b.io', 'eve@example.net'],
      body: {
        text: 'call +1 415 555 1234',
        meta: { tag: 'priority' },
      },
      count: 3,
      flag: true,
    };
    const { value, report } = scrub(input);
    expect(value).toEqual({
      to: '[REDACTED:email]',
      cc: ['[REDACTED:email]', '[REDACTED:email]'],
      body: {
        text: 'call [REDACTED:phone]',
        meta: { tag: 'priority' },
      },
      count: 3,
      flag: true,
    });
    expect(report.redacted).toBe(true);
    expect(report.counts.email).toBeGreaterThanOrEqual(1);
    expect(report.counts.phone).toBe(1);
  });

  it('returns an unredacted report when payload has no PII', () => {
    const { value, report } = scrub({ subject: 'meeting tomorrow', priority: 'high' });
    expect(value).toEqual({ subject: 'meeting tomorrow', priority: 'high' });
    expect(report.redacted).toBe(false);
    expect(report.counts).toEqual({});
  });

  it('does not mutate the original input', () => {
    const input = { to: 'a@b.com' };
    const { value } = scrub(input);
    expect(input.to).toBe('a@b.com');
    expect(value.to).toBe('[REDACTED:email]');
  });

  it('passes through Buffers and other non-plain objects opaque', () => {
    // Scrubbing a Buffer's bytes would corrupt binary tool args. The
    // contract is "we scrub plain JSON shapes only" — Buffers and
    // class instances pass through.
    const buf = Buffer.from('aGVsbG8=', 'base64');
    const input = { attachment: buf, note: 'see jane@x.com' };
    const { value } = scrub(input);
    expect(value.attachment).toBe(buf);
    expect(value.note).toBe('see [REDACTED:email]');
  });

  it('handles primitive payloads (string, number, null)', () => {
    expect(scrub('hit me at a@b.com').value).toBe('hit me at [REDACTED:email]');
    expect(scrub(42).value).toBe(42);
    expect(scrub(null).value).toBeNull();
  });

  it('handles empty objects and arrays', () => {
    expect(scrub({}).value).toEqual({});
    expect(scrub([]).value).toEqual([]);
    expect(scrub({ a: [], b: {} }).value).toEqual({ a: [], b: {} });
  });
});
