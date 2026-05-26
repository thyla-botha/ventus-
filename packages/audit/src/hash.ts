import { createHash } from 'node:crypto';

// Deterministic JSON serialization for stable payload hashes.
//
// Rules (matched to JSON.stringify so a hash computed in-memory equals a
// re-hash of the same payload after a JSON round-trip):
//   - Object keys are sorted lexicographically (recursive).
//   - Object entries whose value is undefined / function / symbol are dropped
//     (these are dropped by JSON.stringify).
//   - Array slots that are undefined / function / symbol become null
//     (matching JSON.stringify behavior).
//   - Non-finite numbers (NaN, Infinity) serialize as null (matching JSON).
//
// Hashing top-level undefined / function / symbol is an error — these values
// have no JSON representation and recording such a hash would silently
// degrade the tamper-evidence guarantee.
export function canonicalize(v: unknown): string {
  if (v === undefined) {
    throw new Error('canonicalize: value has no JSON representation (undefined)');
  }
  if (typeof v === 'function' || typeof v === 'symbol') {
    throw new Error(`canonicalize: value has no JSON representation (${typeof v})`);
  }
  if (typeof v === 'bigint') {
    throw new Error('canonicalize: bigint is not JSON-serializable');
  }
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return (
      '[' +
      v
        .map((item) => {
          if (
            item === undefined ||
            typeof item === 'function' ||
            typeof item === 'symbol'
          ) {
            return 'null';
          }
          return canonicalize(item);
        })
        .join(',') +
      ']'
    );
  }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const entries = Object.keys(obj)
      .filter((k) => {
        const val = obj[k];
        return (
          val !== undefined && typeof val !== 'function' && typeof val !== 'symbol'
        );
      })
      .sort();
    return (
      '{' +
      entries
        .map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') +
      '}'
    );
  }
  // Unreachable for valid JSON inputs.
  return JSON.stringify(v);
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}
