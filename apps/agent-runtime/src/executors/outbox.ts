import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

// Tiny append-only JSON store used by mock executors to simulate outbound
// delivery. Each line of work appends one record so a human can `cat
// .ventus/outbox.json` and see the full history.

interface OutboxFile {
  version: 1;
  deliveries: OutboxRecord[];
}

export interface OutboxRecord {
  id: string;
  channel: string;
  proposalId: string;
  tenantId: string;
  payload: unknown;
  deliveredAt: string;
}

function emptyOutbox(): OutboxFile {
  return { version: 1, deliveries: [] };
}

// Per-path serializer chain. Concurrent appendToOutbox(path, ...) calls
// queue against the same Promise so the read-modify-write cycle is atomic
// within a single process. Two processes sharing the same path can still
// race — file-backed outbox is a dev convenience, not a durable store.
const writeLocks = new Map<string, Promise<void>>();

export async function appendToOutbox(
  path: string,
  rec: Omit<OutboxRecord, 'id' | 'deliveredAt'>,
): Promise<OutboxRecord> {
  const full: OutboxRecord = {
    ...rec,
    id: randomUUID(),
    deliveredAt: new Date().toISOString(),
  };
  const prev = writeLocks.get(path) ?? Promise.resolve();
  const next = prev.then(async () => {
    const state = await loadOutbox(path);
    state.deliveries.push(full);
    await writeOutbox(path, state);
  });
  writeLocks.set(
    path,
    next.catch(() => undefined),
  );
  await next;
  return full;
}

async function loadOutbox(path: string): Promise<OutboxFile> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as OutboxFile;
    return parsed.version === 1 ? parsed : emptyOutbox();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyOutbox();
    throw err;
  }
}

async function writeOutbox(path: string, data: OutboxFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, path);
}
