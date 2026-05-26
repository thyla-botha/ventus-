import { describe, expect, it } from 'vitest';
import { canonicalize, hashPayload } from './hash.js';

describe('canonicalize', () => {
  it('sorts object keys recursively for stable hashes', () => {
    const a = { b: 1, a: 2, c: { y: 3, x: 4 } };
    const b = { a: 2, b: 1, c: { x: 4, y: 3 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":2,"b":1,"c":{"x":4,"y":3}}');
  });

  it('drops undefined values from objects (matches JSON.stringify)', () => {
    const before = { a: 1, b: undefined, c: 3 };
    const after = JSON.parse(JSON.stringify(before));
    expect(canonicalize(before)).toBe(canonicalize(after));
    expect(canonicalize(before)).toBe('{"a":1,"c":3}');
  });

  it('drops function values from objects (matches JSON.stringify)', () => {
    const before = { a: 1, b: () => 2 };
    expect(canonicalize(before)).toBe('{"a":1}');
  });

  it('drops symbol values from objects (matches JSON.stringify)', () => {
    const before = { a: 1, b: Symbol('x') };
    expect(canonicalize(before)).toBe('{"a":1}');
  });

  it('replaces undefined array slots with null (matches JSON.stringify)', () => {
    const arr = [1, undefined, 3];
    const round = JSON.parse(JSON.stringify(arr));
    expect(canonicalize(arr)).toBe(canonicalize(round));
    expect(canonicalize(arr)).toBe('[1,null,3]');
  });

  it('serializes nested arrays of objects deterministically', () => {
    const a = { items: [{ b: 1, a: 2 }, { d: 3, c: 4 }] };
    const b = { items: [{ a: 2, b: 1 }, { c: 4, d: 3 }] };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('treats non-finite numbers as null (matches JSON.stringify)', () => {
    expect(canonicalize({ a: NaN })).toBe('{"a":null}');
    expect(canonicalize({ a: Infinity })).toBe('{"a":null}');
    expect(canonicalize({ a: -Infinity })).toBe('{"a":null}');
  });

  it('handles null, strings, booleans, finite numbers', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize(0)).toBe('0');
    expect(canonicalize('hi')).toBe('"hi"');
  });

  it('throws on top-level undefined (no JSON representation)', () => {
    expect(() => canonicalize(undefined)).toThrow(/no JSON representation/);
  });

  it('throws on top-level function and symbol', () => {
    expect(() => canonicalize(() => 1)).toThrow(/no JSON representation/);
    expect(() => canonicalize(Symbol('x'))).toThrow(/no JSON representation/);
  });

  it('throws on bigint (not JSON-serializable)', () => {
    expect(() => canonicalize(123n)).toThrow(/bigint/);
  });

  it('escapes strings exactly like JSON.stringify (quotes, backslashes, control chars)', () => {
    const tricky = 'a "b" \\ \n \t';
    expect(canonicalize(tricky)).toBe(JSON.stringify(tricky));
  });

  it('is invariant under JSON round-trip — critical for tamper evidence', () => {
    const payloads: unknown[] = [
      { to: 'x@y.com', subject: 's', body: 'b' },
      { a: 1, b: undefined, c: [1, undefined, 'x'] },
      { nested: { z: 1, a: { c: 2, b: 3 } } },
      [{ b: 2, a: 1 }, null, 'hi'],
    ];
    for (const p of payloads) {
      const round = JSON.parse(JSON.stringify(p));
      expect(canonicalize(p)).toBe(canonicalize(round));
    }
  });
});

describe('hashPayload', () => {
  it('produces 64-char hex sha256', () => {
    const h = hashPayload({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across key reorderings', () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });

  it('matches re-hash after JSON round-trip (tamper-evidence invariant)', () => {
    const p = { to: 'x@y.com', meta: { tags: ['a', 'b'], optional: undefined } };
    const round = JSON.parse(JSON.stringify(p));
    expect(hashPayload(p)).toBe(hashPayload(round));
  });

  it('different payloads hash differently', () => {
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });
});
