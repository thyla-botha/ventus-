import { jwtVerify, type JWTPayload } from 'jose';
import { isUuid } from '@ventus/shared';
import type { UserRole } from './tenant.js';

// Supabase JWT verifier. HS256 with a shared secret — no network call per
// request. The secret comes from SUPABASE_JWT_SECRET in env; this is the
// SAME secret the Supabase platform uses to sign access tokens for the
// project, configured under Project Settings > API > JWT Settings.
//
// Why not call supabase.auth.getUser(token)? That round-trips to Supabase
// per request, which adds 50-200ms of tail latency to every authenticated
// request and creates a hard dep on Supabase being reachable from the API
// node. Local HS256 verification is the standard approach — Supabase
// signs, we verify, the trust boundary is the secret.
//
// Claim shape (set via Supabase Auth Hooks → "Custom Access Token Hook"):
//
//   {
//     "iss": "https://<project>.supabase.co/auth/v1",
//     "aud": "authenticated",
//     "sub": "<user uuid>",              // -> userId
//     "tenant_id": "<tenant uuid>",       // custom claim
//     "user_role": "admin" | "member",    // custom claim
//     "exp": 1700000000,
//     ...
//   }
//
// Tokens MUST carry tenant_id + user_role custom claims — without them the
// token is rejected (not silently demoted to 'member'). A missing claim
// means the Supabase hook is misconfigured, which is a deploy-time bug we
// want to fail-loud on, not paper over per request.

export interface VerifiedClaims {
  userId: string;
  tenantId: string;
  userRole: UserRole;
}

export class JwtVerifyError extends Error {
  // status defaults to 401 — token missing / invalid / expired. 403 is
  // reserved for tokens that VERIFY but lack required claims (deploy bug).
  constructor(message: string, public readonly status: 401 | 403 = 401) {
    super(message);
    this.name = 'JwtVerifyError';
  }
}

// Cached secret key. The secret is process-lifetime stable — re-encoding
// it per call would waste cycles on the hot path. Encoded lazily so a
// process that never sees a Bearer header (pure dev-shim mode) doesn't
// crash if SUPABASE_JWT_SECRET is unset.
let cachedSecret: Uint8Array | null = null;
function getSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  const raw = process.env.SUPABASE_JWT_SECRET;
  if (!raw) {
    throw new JwtVerifyError(
      'SUPABASE_JWT_SECRET not set; cannot verify Bearer tokens',
      401,
    );
  }
  cachedSecret = new TextEncoder().encode(raw);
  return cachedSecret;
}

// Reset for tests — only path that should ever clear the cache. Letting
// real code re-encode would mask a secret-rotation bug at runtime.
export function resetJwtSecretForTests(): void {
  cachedSecret = null;
}

const ROLE_VALUES: readonly string[] = ['admin', 'member'];

export async function verifyBearerToken(token: string): Promise<VerifiedClaims> {
  let payload: JWTPayload;
  try {
    const verifyOpts: Parameters<typeof jwtVerify>[2] = {
      // Supabase issues with aud='authenticated' for signed-in users. An
      // anon-key token has aud='anon' — those callers are not real users
      // and must not pass our gate.
      audience: 'authenticated',
      // CODEX MEDIUM-7: pin the algorithm to HS256. jose otherwise honours
      // the token's `alg` header, which opens an algorithm-confusion
      // window if the secret happens to be interpretable as a PEM (we
      // never use one, but defense-in-depth — pin and stop worrying).
      algorithms: ['HS256'],
    };
    // Issuer pinning. Optional but recommended in non-dev: set
    // SUPABASE_JWT_ISSUER to `https://<project>.supabase.co/auth/v1` to
    // require the token to come from your specific Supabase project.
    // Without this, any token signed by anyone holding your secret (e.g.
    // a stale copy that was rotated server-side but the new attacker
    // still has the old) would pass aud=authenticated.
    const issuer = process.env.SUPABASE_JWT_ISSUER;
    if (issuer) {
      verifyOpts.issuer = issuer;
    }
    const verified = await jwtVerify(token, getSecret(), verifyOpts);
    payload = verified.payload;
  } catch (err) {
    if (err instanceof JwtVerifyError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new JwtVerifyError(`invalid token: ${msg}`, 401);
  }

  const sub = payload.sub;
  if (typeof sub !== 'string' || !isUuid(sub)) {
    throw new JwtVerifyError('token sub is not a valid user uuid', 401);
  }

  // tenant_id is a custom claim. Missing/non-UUID means the Supabase
  // custom-access-token hook is misconfigured — treat as a deploy bug
  // (403) so it surfaces during dogfooding instead of silently locking
  // users into a 'no tenant' state.
  const tenantClaim = payload['tenant_id'];
  if (typeof tenantClaim !== 'string' || !isUuid(tenantClaim)) {
    throw new JwtVerifyError(
      'token missing or invalid tenant_id custom claim',
      403,
    );
  }

  const roleClaim = payload['user_role'];
  if (typeof roleClaim !== 'string' || !ROLE_VALUES.includes(roleClaim)) {
    throw new JwtVerifyError(
      'token missing or invalid user_role custom claim',
      403,
    );
  }

  return {
    userId: sub.toLowerCase(),
    tenantId: tenantClaim.toLowerCase(),
    userRole: roleClaim as UserRole,
  };
}

// Convenience wrapper for the middleware. Returns null when no Bearer
// header is present (so the caller can decide whether to fall through to
// the dev shim or 401). Throws JwtVerifyError on a present-but-bad token.
export async function tryVerifyAuthHeader(
  authHeader: string | undefined,
): Promise<VerifiedClaims | null> {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match || !match[1]) {
    throw new JwtVerifyError('malformed Authorization header', 401);
  }
  return verifyBearerToken(match[1]);
}
