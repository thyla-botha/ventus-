export { withTenant, getTenantClient } from './client.js';
export type { TenantClient, TenantContext, Db } from './client.js';
// withAdmin is deliberately NOT re-exported here — importing it bypasses
// RLS, so the import path must remain `@ventus/db/admin` so the tenancy
// lint can audit every caller against ALLOWED_ADMIN_IMPORTERS.
export type * from './types.js';
