import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { tenantContext } from './middleware/tenant.js';
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
  app.route('/v1/tenant/profile', tenantProfile);
  return app;
}

export type AppType = ReturnType<typeof createApp>;
