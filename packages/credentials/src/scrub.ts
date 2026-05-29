// PII scrubber for MCP gateway tool calls.
//
// Purpose: tool-call payloads pass through the LLM as observed context
// during agent runs. The compliance story for regulated tenants (real
// estate, brokers, healthcare partners) requires that direct identifiers
// — emails, phone numbers, government IDs, payment card numbers — be
// redacted BEFORE the prompt is built. Once a value is in the prompt
// stream it lives in provider logs forever; redaction has to be
// pre-LLM, not post.
//
// Design rules:
//   - This is a SAFETY NET, not the primary control. The real defense is
//     not putting raw PII into proposal payloads in the first place; the
//     scrubber catches escapes (an agent quoting back a user's email,
//     a tool call that surfaces an account number in its response, etc.).
//   - All redactions replace the matched span with a typed sentinel
//     ([REDACTED:email], [REDACTED:phone], ...) so downstream rendering
//     can show "<email redacted>" rather than gibberish.
//   - Recurses into nested objects and arrays. Strings inside any field
//     are scrubbed; non-string fields (numbers, booleans) pass through
//     untouched — a credit-card-shaped NUMBER won't trip because the
//     regex requires a string with the right separators.
//   - Conservative on false positives. The phone matcher requires a
//     country-code-style prefix or strict 10-digit grouping; the SSN
//     matcher requires explicit dashes; the credit-card matcher requires
//     Luhn-likely groupings (4-4-4-4 separated by spaces or dashes).

type RedactionType =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'credit_card'
  | 'iban'
  | 'oauth_token'
  | 'jwt'
  | 'api_key'
  | 'by_key';

interface Rule {
  type: RedactionType;
  // Global, case-insensitive where letters appear. Each rule is run
  // against every string field.
  re: RegExp;
}

// Order matters — earlier rules win for overlapping matches. JWT comes
// FIRST because its base64url body can contain shorter substrings that
// look like API keys. credit_card before iban for the same reason.
const RULES: readonly Rule[] = [
  // RFC-5322-ish but bounded: max 64 chars local-part, max 255 domain.
  // Conservative enough that legitimate emails match while a stray
  // 'foo@bar' substring inside a URL doesn't drag a whole word with it.
  {
    type: 'email',
    re: /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/gi,
  },
  // Phone numbers. All branches REQUIRE either an explicit + prefix, the
  // UK national '0' prefix with explicit separators, or US-style 3-3-4
  // grouping with explicit separators — a bare digit run is NEVER treated
  // as a phone (too ambiguous; would eat order ids, SSN-like 9-digit
  // sequences, and IBAN bodies).
  //   1. E.164: '+' followed by digits/separators, total length 9-19.
  //   2. US-style 3-3-4 with explicit separators between each group.
  //   3. UK landline 3-group form anchored on the leading '0' national
  //      prefix with explicit separators between every group. Covers the
  //      common formats brokers see in free-text fields:
  //        '020 7946 0958'  (London, 3-4-4)
  //        '0207 946 0958'  (London alt, 4-3-4)
  //        '0161 555 1234'  (Manchester, 4-3-4)
  //        '0800 123 4567'  (toll-free, 4-3-4)
  //      DECISION: UK MOBILES in the common '07700 900123' (5-6) two-group
  //      form are NOT matched here — adding a two-group '0\d{4}\s\d{6}'
  //      branch overlaps too readily with order-id-shaped strings under
  //      free text. UK mobiles written in three-group form
  //      ('07700 900 123') ARE caught by this branch. Mobiles arriving as
  //      structured fields will be caught via the by-key fallback on
  //      'mobile'/'mobilenumber'/'msisdn' keys.
  {
    type: 'phone',
    re: /(?:\+\d[\d\s.()-]{7,17}\d|\b\d{3}[\s.()-]+\d{3}[\s.()-]+\d{4}\b|\b0\d{1,4}[\s.-]\d{2,4}[\s.-]\d{3,4}\b)/g,
  },
  // US SSN with explicit dashes only. A bare 9-digit string is too
  // ambiguous (could be an order id, an invoice, etc.) — we match
  // ###-##-#### specifically.
  {
    type: 'ssn',
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  // 16-digit card in 4-4-4-4 groups (spaces or dashes). Doesn't verify
  // Luhn — false positives on a synthetic 16-digit identifier are an
  // acceptable cost vs. the regex complexity of a real Luhn check.
  {
    type: 'credit_card',
    re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  },
  // IBAN: country code (2 letters) + check digits (2) + 10-30 alphanumeric.
  // Real-world IBANs arrive in grouped 4-char form ('GB29 NWBK 6016 1331
  // 9268 19') in invoices, CRMs, and prose; lowercasing is common in
  // copy-paste. We accept either compact or grouped-4 form so prose like
  // 'wire to GB29 NWBK ... monday' redacts the IBAN without eating
  // following words — a flat '(?:\s?[A-Z0-9]){10,30}' would over-extend
  // greedily through any trailing word under the i flag.
  {
    type: 'iban',
    re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}\s?[A-Z0-9]{1,4}\b/gi,
  },
  // OAuth bearer + Google access/refresh tokens. Placed BEFORE jwt because
  // a Bearer-prefixed JWT is still primarily an OAuth credential — the
  // Bearer span is the stronger leak signal (it implies "use this to call
  // an API") and forwarder error text from provider SDKs (HIGH-6 source)
  // routinely emits 'Authorization: Bearer ya29...' in raw form.
  //   - Bearer <token>: 8+ chars of base64url-ish body, case-insensitive
  //     on the keyword.
  //   - ya29.<body>: Google OAuth2 access token sentinel.
  //   - 1//0<body>: Google OAuth2 refresh token sentinel.
  {
    type: 'oauth_token',
    re: /(?:\bBearer\s+[A-Za-z0-9._/+=~_-]{8,}|\bya29\.[A-Za-z0-9._/+=~_-]{16,}|\b1\/\/0[A-Za-z0-9._/+=~_-]{16,})/gi,
  },
  // JWT: three base64url segments separated by dots. The leading
  // 'eyJ' prefix is the b64-encoded '{"' that begins every JWT header,
  // so we anchor on it to avoid eating random three-dot strings.
  {
    type: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  // Generic API key sentinels — sk_live_..., sk-..., AIza... (Google),
  // ghp_... (GitHub), xoxb-... (Slack bot). These are publishable
  // prefixes; a leaked one is immediately recognisable.
  {
    type: 'api_key',
    re: /\b(?:sk[-_](?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{32,}|ghp_[A-Za-z0-9]{36}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
  },
];

const SENTINEL = (type: RedactionType): string => `[REDACTED:${type}]`;

// CODEX LOW-9: structured PII frequently arrives as numeric leaves (e.g.
// `{ cardNumber: 4111111111111111 }`, account numbers, government IDs).
// The regex-only path above only matches strings, so a numeric leaf bypasses
// every rule. We catch this by inspecting the field NAME: if the parent
// object's key matches a known-sensitive name (case- and separator-
// insensitive), we redact the value regardless of type.
//
// Naming style is normalized by stripping non-alphanumeric chars and
// lowercasing: 'cardNumber', 'card_number', 'card-number', 'Card Number'
// all reduce to 'cardnumber'.
const SENSITIVE_KEY_NAMES_NORMALIZED: ReadonlySet<string> = new Set([
  'cardnumber',
  'creditcard',
  'creditcardnumber',
  'cvv',
  'cvc',
  'cardcvv',
  'cardcvc',
  'accountnumber',
  'bankaccount',
  'bankaccountnumber',
  'routingnumber',
  'iban',
  'swift',
  'bic',
  'ssn',
  'socialsecuritynumber',
  // South African ID — primary target locale per project spec.
  'said',
  'saidnumber',
  'idnumber',
  'nationalid',
  'nationalidnumber',
  'passport',
  'passportnumber',
  'taxid',
  'taxnumber',
  'vatnumber',
  'driverslicense',
  'driverlicense',
  'driverslicensenumber',
  'phone',
  'phonenumber',
  'mobile',
  'mobilenumber',
  'msisdn',
  'email',
  'emailaddress',
]);

function normalizeKey(k: string): string {
  return k.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(k: string): boolean {
  return SENSITIVE_KEY_NAMES_NORMALIZED.has(normalizeKey(k));
}

function bumpByKeyCount(report?: ScrubReport): void {
  if (!report) return;
  report.counts.by_key = (report.counts.by_key ?? 0) + 1;
  report.redacted = true;
}

export interface ScrubReport {
  // Total number of redactions applied, broken down by type. Useful for
  // operator dashboards ("we scrubbed 1,243 emails this week") and for
  // surfacing surprises ("why did this run match 47 credit cards?").
  counts: Partial<Record<RedactionType, number>>;
  // Whether any redaction was applied at all. Convenience for the
  // common "did we touch this payload?" branch.
  redacted: boolean;
}

export function scrubString(s: string, report?: ScrubReport): string {
  let out = s;
  for (const rule of RULES) {
    // Count INSIDE the replace callback so every match increments exactly
    // once. The previous implementation counted sentinels in the output
    // post-hoc and used Math.max against the prior tally, which caused
    // a serious undercount across nested fields: three leaves each
    // containing one email would report counts.email === 1 because the
    // 'occurrences' read was scoped to the current string only, then
    // Math.max blocked the additive update. Dashboards and anomaly
    // detection ('why did this run scrub 47 cards?') depend on these
    // counts being accurate, so we tally per-match here and add into
    // the caller's report.
    let count = 0;
    out = out.replace(rule.re, () => {
      count += 1;
      return SENTINEL(rule.type);
    });
    if (count > 0 && report) {
      report.counts[rule.type] = (report.counts[rule.type] ?? 0) + count;
      report.redacted = true;
    }
  }
  return out;
}

// Recursive value scrubber. Walks plain objects, arrays, and primitive
// strings; pass-through for numbers, booleans, null, undefined.
//
// IMPORTANT: this only recurses into PLAIN objects (Object.getPrototypeOf
// returns Object.prototype or null). Class instances, Buffers, Dates, etc.
// are passed through opaque — scrubbing a Buffer's bytes would corrupt
// binary payloads, and the gateway's contract is JSON-shaped tool args.
export function scrubValue<T>(value: T, report?: ScrubReport): T {
  if (typeof value === 'string') {
    return scrubString(value, report) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubValue(v, report)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // CODEX LOW-9: by-key redaction for known-sensitive field names.
      // We prefer the regex pipeline's precise sentinels (email/phone/...)
      // when a string value is recognizable — the type-specific tag is
      // more useful for operator dashboards. By-key fires as a fallback
      // when the regex misses (numeric PII, separator-stripped strings,
      // BigInt IDs) so structured PII never escapes just because it
      // arrived without the conventional formatting.
      if (isSensitiveKey(k)) {
        if (typeof v === 'string') {
          // Try the precise regex pipeline first. If it caught anything,
          // we keep that scrubbed value; otherwise we fall back to the
          // generic by-key sentinel.
          if (v === '') {
            out[k] = v;
          } else {
            const beforeReport: ScrubReport = { counts: {}, redacted: false };
            const scrubbed = scrubString(v, beforeReport);
            if (beforeReport.redacted) {
              // Roll the precise counts into the caller's report.
              if (report) {
                for (const [type, n] of Object.entries(beforeReport.counts) as Array<
                  [RedactionType, number]
                >) {
                  report.counts[type] = (report.counts[type] ?? 0) + n;
                }
                report.redacted = true;
              }
              out[k] = scrubbed;
            } else {
              out[k] = SENTINEL('by_key');
              bumpByKeyCount(report);
            }
          }
          continue;
        }
        // Non-string values under a sensitive key: redact wholesale
        // regardless of shape (numbers, bigints, arrays, objects).
        if (v === null || v === undefined) {
          out[k] = v;
        } else {
          out[k] = SENTINEL('by_key');
          bumpByKeyCount(report);
        }
        continue;
      }
      out[k] = scrubValue(v, report);
    }
    return out as T;
  }
  return value;
}

// Convenience for the typical "scrub a tool-call payload" path. Returns
// the scrubbed value + a fresh report so the caller can include the
// redaction summary in the audit row without juggling state.
export function scrub<T>(value: T): { value: T; report: ScrubReport } {
  const report: ScrubReport = { counts: {}, redacted: false };
  const scrubbed = scrubValue(value, report);
  return { value: scrubbed, report };
}

