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

describe('scrub — by-key redaction (CODEX LOW-9)', () => {
  it('redacts a numeric card number under a sensitive key', () => {
    // Pre-fix bug: numeric PII slipped through because the regex pipeline
    // only inspected string leaves. By-key redaction fires on the field
    // name regardless of leaf type.
    const { value, report } = scrub({ cardNumber: 4111111111111111 });
    expect((value as unknown as { cardNumber: string }).cardNumber).toBe('[REDACTED:by_key]');
    expect(report.redacted).toBe(true);
    expect(report.counts.by_key).toBe(1);
  });

  it('matches sensitive keys across case and separator styles', () => {
    const { value } = scrub({
      card_number: 4111111111111111,
      'Card Number': 4111111111111111,
      cardnumber: 4111111111111111,
      CARDNUMBER: 4111111111111111,
    });
    for (const v of Object.values(value as Record<string, unknown>)) {
      expect(v).toBe('[REDACTED:by_key]');
    }
  });

  it('redacts a South African ID number stored as a numeric field', () => {
    // Locale-specific PII. SA IDs are 13-digit numbers stored under
    // saId/idNumber/nationalId in real broker/realestate systems.
    const { value, report } = scrub({
      saId: 9001011234084,
      idNumber: '900101 1234 084',
      nationalId: 9001011234084,
    });
    expect((value as unknown as { saId: string }).saId).toBe('[REDACTED:by_key]');
    expect((value as { idNumber: string }).idNumber).toBe('[REDACTED:by_key]');
    expect((value as unknown as { nationalId: string }).nationalId).toBe('[REDACTED:by_key]');
    expect(report.counts.by_key).toBe(3);
  });

  it('falls back to by_key for string PII that no regex rule covers (e.g. 13-digit SA ID string)', () => {
    // The credit_card regex DOES match a 16-digit run (separators are
    // optional in the rule), so a 16-digit account number would tag as
    // [REDACTED:credit_card] — that is the preferred precise sentinel.
    // The by_key fallback fires for shapes no rule catches: a 13-digit
    // SA ID stored as a string has no separators and is not 16 digits,
    // so the regex pipeline misses it and by_key fills the gap.
    const { value } = scrub({ saIdNumber: '9001011234084' });
    expect((value as { saIdNumber: string }).saIdNumber).toBe('[REDACTED:by_key]');
  });

  it('prefers the precise regex sentinel over by_key when both could fire', () => {
    // accountNumber + 16-digit credit-card-shaped string: regex wins,
    // by_key never fires. The precise tag is more useful downstream.
    const { value, report } = scrub({ accountNumber: '4111111111111111' });
    expect((value as { accountNumber: string }).accountNumber).toBe('[REDACTED:credit_card]');
    expect(report.counts.credit_card).toBe(1);
    expect(report.counts.by_key ?? 0).toBe(0);
  });

  it('redacts nested objects/arrays wholesale under a sensitive key', () => {
    const { value } = scrub({
      passport: { country: 'ZA', number: 'A0123456' },
      driversLicense: ['front.jpg', 'back.jpg'],
    });
    expect((value as { passport: unknown }).passport).toBe('[REDACTED:by_key]');
    expect((value as { driversLicense: unknown }).driversLicense).toBe('[REDACTED:by_key]');
  });

  it('preserves null / empty-string under sensitive keys (no false sentinel for absent fields)', () => {
    const { value, report } = scrub({ ssn: null as string | null, idNumber: '' });
    expect((value as { ssn: string | null }).ssn).toBeNull();
    expect((value as { idNumber: string }).idNumber).toBe('');
    expect(report.redacted).toBe(false);
  });

  it('does NOT redact unrelated keys that happen to contain digits', () => {
    // 'orderId', 'invoiceNumber', 'timestamp' are not sensitive — only
    // the named PII keys are. Catches over-broad matchers.
    const { value, report } = scrub({
      orderId: 4111111111111111,
      invoiceNumber: 'INV-4111',
      timestamp: 1700000000000,
    });
    expect(value).toEqual({
      orderId: 4111111111111111,
      invoiceNumber: 'INV-4111',
      timestamp: 1700000000000,
    });
    expect(report.redacted).toBe(false);
  });
});
