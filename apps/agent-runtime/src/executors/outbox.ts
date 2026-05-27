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

export interface AppendInput extends Omit<OutboxRecord, 'id' | 'deliveredAt'> {
  // Optional caller-supplied id used to make this append at-most-once. When
  // present, the record is stored with id=idempotencyKey:
  //
  //   - second call with the same key + same tenantId returns the existing
  //     row unchanged (the executor's downstream side effect was already
  //     committed by the first call).
  //   - second call with the same key + a DIFFERENT tenantId is a data
  //     integrity violation (two tenants converged on the same delivery id)
  //     and throws. We refuse to silently dedupe across tenant boundaries.
  //
  // When absent, a fresh UUID is minted — preserves existing behaviour for
  // callers that don't care about idempotency.
  idempotencyKey?: string;
}

export class OutboxIdempotencyConflictError extends Error {
  constructor(
    public readonly idempotencyKey: string,
    public readonly existingTenantId: string,
    public readonly attemptedTenantId: string,
  ) {
    super(
      `outbox idempotency conflict: id=${idempotencyKey} already exists for tenant ${existingTenantId}, refusing to reuse for tenant ${attemptedTenantId}`,
    );
    this.name = 'OutboxIdempotencyConflictError';
  }
}

export async function appendToOutbox(
  path: string,
  rec: AppendInput,
): Promise<OutboxRecord> {
  const { idempotencyKey, ...rest } = rec;
  const prev = writeLocks.get(path) ?? Promise.resolve();
  let result!: OutboxRecord;
  const next = prev.then(async () => {
    const state = await loadOutbox(path);
    if (idempotencyKey) {
      const existing = state.deliveries.find((d) => d.id === idempotencyKey);
      if (existing) {
        if (existing.tenantId !== rest.tenantId) {
          throw new OutboxIdempotencyConflictError(
            idempotencyKey,
            existing.tenantId,
            rest.tenantId,
          );
        }
        // Belt-and-suspenders: today idempotencyKey === proposal.id, so a same-
        // tenant collision must also be the same proposal. If a future caller
        // ever supplies a business-level key, a proposalId mismatch would mean
        // two distinct proposals collided on the same key — refuse to dedupe.
        if (existing.proposalId !== rest.proposalId) {
          throw new OutboxIdempotencyConflictError(
            idempotencyKey,
            existing.tenantId,
            rest.tenantId,
          );
        }
        result = existing;
        return;
      }
    }
    const full: OutboxRecord = {
      ...rest,
      id: idempotencyKey ?? randomUUID(),
      deliveredAt: new Date().toISOString(),
    };
    state.deliveries.push(full);
    await writeOutbox(path, state);
    result = full;
  });
  writeLocks.set(
    path,
    next.catch(() => undefined),
  );
  await next;
  return result;
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
