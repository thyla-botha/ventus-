import { Hono } from 'hono';
import { getAppState } from '../state.js';

// HTTP surface for the audit trail. Every read is tenant-scoped via the
// middleware-derived c.var.tenantId. Filters narrow to a specific resource
// (e.g. resourceType=proposal&resourceId=<id>) or run (?runId=...). Without
// filters it returns the most recent N events for the whole tenant.
//
//   GET /v1/audit                           recent events
//   GET /v1/audit?resourceId=<uuid>         events touching one resource
//   GET /v1/audit?resourceType=proposal     all proposal events
//   GET /v1/audit?runId=<id>                events for one agent run
//   GET /v1/audit?limit=20                  cap the result set

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export const audit = new Hono().get('/', async (c) => {
  const tenantId = c.var.tenantId;
  const resourceType = c.req.query('resourceType');
  const resourceId = c.req.query('resourceId');
  const runId = c.req.query('runId');
  const limitParam = c.req.query('limit');

  let limit = limitParam !== undefined ? Number(limitParam) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) {
    return c.json({ error: 'limit must be a positive integer' }, 400);
  }
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const { audit: store } = getAppState();
  const rows = await store.listAuditTrail({
    tenantId,
    resourceType,
    resourceId,
    runId,
    limit,
  });
  return c.json({ events: rows });
});
