#!/usr/bin/env node
import { SignJWT } from 'jose';

// Mint a Supabase-shaped access token signed with the local
// SUPABASE_JWT_SECRET. Use this for local dev when you want to exercise the
// JWT-only auth path (VENTUS_DEV_DEFAULT_TENANT unset on the API) without
// standing up a real Supabase project.
//
// Usage:
//
//   SUPABASE_JWT_SECRET=... pnpm --filter @ventus/api sign-dev-jwt \
//     --tenant <uuid> --user <uuid> --role admin
//
//   # then in apps/web:
//   VENTUS_API_BEARER=<token> pnpm dev
//
// The minted token mirrors the shape verified by middleware/jwt-verify.ts:
// sub = userId, custom tenant_id, custom user_role, audience='authenticated',
// HS256 signed.
//
// SAFETY: the token grants whatever role you sign in with. Treat the secret
// and the resulting token like a password; never commit either.

interface Args {
  tenant: string;
  user: string;
  role: 'admin' | 'member';
  expiresIn: string;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k || v === undefined) continue;
    switch (k) {
      case '--tenant':
        out.tenant = v;
        break;
      case '--user':
        out.user = v;
        break;
      case '--role':
        if (v !== 'admin' && v !== 'member') {
          throw new Error(`role must be admin or member, got ${v}`);
        }
        out.role = v;
        break;
      case '--expires-in':
        out.expiresIn = v;
        break;
      default:
        throw new Error(`unknown flag: ${k}`);
    }
  }
  if (!out.tenant || !out.user) {
    throw new Error('--tenant and --user are required (both UUIDs)');
  }
  return {
    tenant: out.tenant,
    user: out.user,
    role: out.role ?? 'member',
    expiresIn: out.expiresIn ?? '1d',
  };
}

async function main(): Promise<void> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    // eslint-disable-next-line no-console
    console.error('SUPABASE_JWT_SECRET not set. Set it to the same value the API uses.');
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  const token = await new SignJWT({
    tenant_id: args.tenant,
    user_role: args.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(args.user)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(args.expiresIn)
    .sign(new TextEncoder().encode(secret));
  // eslint-disable-next-line no-console
  console.log(token);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
