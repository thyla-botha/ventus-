import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { tenantContext } from './middleware/tenant.js';
import { admin } from './routes/admin.js';
import { googleOAuthCallback, googleOAuthStart } from './routes/google-oauth.js';
import { health } from './routes/health.js';
import { proposals } from './routes/proposals.js';
import { audit } from './routes/audit.js';
import { runs } from './routes/runs.js';
import { skills } from './routes/skills.js';
import { tenantProfile } from './routes/tenant-profile.js';

// Builds the Hono app without binding a port. The dev server (index.ts) and
// tests both go through here so route wiring is exercised the same way in both.

export function createApp(): Hono {
  const app = new Hono();
  app.use('*', logger());
  app.use('/v1/*', tenantContext());
  app.route('/health', health);
  app.route('/v1/proposals', proposals);
  app.route('/v1/audit', audit);
  app.route('/v1/runs', runs);
  app.route('/v1/skills', skills);
  // Mounted at /v1/tenant so the router can host both /profile and /runtime
  // sub-resources under one Hono. The two sub-resources share the same admin
  // gate + audit pattern but are independently mutable (changing the runtime
  // override must not churn the profile body's contentHash).
  app.route('/v1/tenant', tenantProfile);
  app.route('/v1/admin', admin);
  // Gmail OAuth onboarding. /start needs the tenant gate (admin-only,
  // signs the state token for the caller's tenantId); /callback runs
  // OUTSIDE /v1 because Google can't carry our Authorization header and
  // we identify the tenant from the signed state instead.
  app.route('/v1/auth/google', googleOAuthStart);
  app.route('/auth/google', googleOAuthCallback);
  return app;
}

export type AppType = ReturnType<typeof createApp>;
