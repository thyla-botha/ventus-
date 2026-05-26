import { Worker, type Processor } from 'bullmq';
import IORedis from 'ioredis';

// Worker entrypoint. Every job payload carries tenantId; processors must call
// withTenant(...) before touching the database. Service-role queries are
// forbidden here — flagged by scripts/lint-tenancy.mjs.

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export interface SyncJob {
  tenantId: string;
  connectorId: string;
  since?: string;
}

const syncProcessor: Processor<SyncJob> = async (_job) => {
  // Sync connector data. Stub.
};

const ingestProcessor: Processor<{ tenantId: string; documentId: string }> = async (_job) => {
  // Chunk + embed + entity-extract a document. Stub.
};

const workers: Worker[] = [
  new Worker('sync', syncProcessor, { connection, concurrency: 4 }),
  new Worker('ingest', ingestProcessor, { connection, concurrency: 2 }),
];

const shutdown = async () => {
  // eslint-disable-next-line no-console
  console.log('ventus worker shutting down');
  await Promise.all(workers.map((w) => w.close()));
  await connection.quit();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// eslint-disable-next-line no-console
console.log('ventus worker started');
