import { mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.shared.js';

// API tests run with the dev header shim enabled by default. The shim is
// the production-OFF path the test suite has used since day one — the
// JWT-only flow has its own test file that explicitly turns the shim off.
export default mergeConfig(baseConfig, {
  test: {
    setupFiles: ['./test-setup.ts'],
  },
});
