import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`ventus api listening on :${info.port}`);
});

export { createApp } from './app.js';
export type { AppType } from './app.js';
