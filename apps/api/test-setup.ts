// Global test setup. Loaded once per worker before any test file imports.
//
// The dev header shim (x-tenant-id / x-user-id / x-user-role) is normally
// gated behind VENTUS_DEV_DEFAULT_TENANT=1 so production cannot fall through
// to header trust by accident. Every test in this suite assumes the shim is
// on because that's how the harness mints headers; opt out per-test by
// `delete process.env.VENTUS_DEV_DEFAULT_TENANT` when exercising the
// JWT-only path (see middleware/tenant-jwt.test.ts).
process.env.VENTUS_DEV_DEFAULT_TENANT ??= '1';
