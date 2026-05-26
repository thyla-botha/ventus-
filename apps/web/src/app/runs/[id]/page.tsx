import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getRun,
  listRunAudit,
  listRunProposals,
  type AuditTrailRow,
  type ProposalRow,
  type RunRow,
} from '@/lib/api';
import { AuditTimeline } from '@/components/audit-timeline';
import { AutoRefresh } from '@/components/auto-refresh';
import { cancelRunAction } from '../actions';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function RunDetailPage({ params }: PageProps) {
  const { id } = await params;

  // Fetch run BEFORE entering the try. notFound() throws a special Next
  // navigation error and must not be swallowed by the API-error catch below.
  let run: RunRow | null = null;
  let topError: string | null = null;
  try {
    run = await getRun(id);
  } catch (e) {
    topError = e instanceof Error ? e.message : String(e);
  }
  if (topError === null && !run) notFound();

  let proposals: ProposalRow[] = [];
  let auditRows: AuditTrailRow[] = [];
  let error: string | null = topError;

  if (run && !error) {
    try {
      // Run-scoped fetches in parallel; both filtered by runId server-side.
      [proposals, auditRows] = await Promise.all([
        listRunProposals(id),
        listRunAudit(id),
      ]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  if (error || !run) {
    return (
      <main className="container">
        <header className="page-header">
          <div>
            <h1>Run</h1>
            <p className="muted">
              <code>{id}</code>
            </p>
          </div>
          <Link href="/runs" className="btn-ghost">&larr; back to runs</Link>
        </header>
        <div className="error">
          <strong>API error.</strong>
          <pre>{error ?? 'run unavailable'}</pre>
        </div>
      </main>
    );
  }

  const isOpen = run.status === 'running';
  const cancelRequested = Boolean(run.cancelRequestedAt);
  const cancel = cancelRunAction.bind(null, run.id);

  return (
    <main className="container">
      {/* Polls every 1.5s only while the loop is open. Self-stops once the
          server returns a terminal status — no further refreshes. */}
      <AutoRefresh active={isOpen} resetKey={run.cancelRequestedAt} />
      <header className="page-header">
        <div>
          <h1>
            <span className={`pill pill-run-${run.status}`}>
              {run.status}
              {isOpen ? ' …' : ''}
            </span>{' '}
            {run.skillId ?? run.agentId}
          </h1>
          <p className="muted">
            <code>{run.id}</code> · started {new Date(run.startedAt).toLocaleString()}
            {run.endedAt ? <> · ended {new Date(run.endedAt).toLocaleString()}</> : null}
          </p>
          {cancelRequested && isOpen ? (
            <p className="muted" style={{ marginTop: 4 }}>
              cancel requested{' '}
              {new Date(run.cancelRequestedAt!).toLocaleString()}
              {run.cancelRequestedBy ? <> by <code>{run.cancelRequestedBy}</code></> : null}
              {' '}— waiting for the loop to stop at the next step.
            </p>
          ) : null}
        </div>
        <div className="header-actions">
          {isOpen && !cancelRequested ? (
            <form action={cancel}>
              <button type="submit" className="btn-danger">
                Cancel run
              </button>
            </form>
          ) : null}
          <Link href="/runs" className="btn-ghost">&larr; back to runs</Link>
        </div>
      </header>

      <div className="stats">
        <Stat label="proposals" value={String(run.proposalCount ?? 0)} />
        <Stat label="cost" value={formatCost(run.totalCostMicros)} />
        <Stat label="duration" value={formatDuration(run.startedAt, run.endedAt)} />
        <Stat label="model" value={run.model ?? '—'} />
      </div>

      {run.userMessage ? (
        <section className="card" style={{ marginTop: '1rem' }}>
          <div className="muted" style={{ fontSize: '0.85rem' }}>user message</div>
          <div>{run.userMessage}</div>
        </section>
      ) : null}

      {run.finalText ? (
        <section className="card" style={{ marginTop: '1rem' }}>
          <div className="muted" style={{ fontSize: '0.85rem' }}>final agent text</div>
          <div>{run.finalText}</div>
        </section>
      ) : null}

      {run.haltReason ? (
        <section className="card" style={{ marginTop: '1rem' }}>
          <div className="muted" style={{ fontSize: '0.85rem' }}>halt reason</div>
          <div>{run.haltReason}</div>
        </section>
      ) : null}

      {run.errorText ? (
        <section className="card" style={{ marginTop: '1rem' }}>
          <div className="muted" style={{ fontSize: '0.85rem' }}>error</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{run.errorText}</pre>
        </section>
      ) : null}

      {run.skillContentHash || run.contextSnapshotHash || run.tenantProfileHash !== undefined ? (
        <section className="card" style={{ marginTop: '1rem' }}>
          <div className="muted" style={{ fontSize: '0.85rem' }}>
            provenance — pins the exact skill bytes + effective context that ran
          </div>
          <div style={{ marginTop: 4, fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }}>
            {run.skillContentHash ? (
              <div>
                <span className="muted">skill: </span>
                <code title={run.skillContentHash}>
                  {run.skillContentHash.slice(0, 16)}
                </code>
              </div>
            ) : null}
            {run.contextSnapshotHash ? (
              <div>
                <span className="muted">context: </span>
                <code title={run.contextSnapshotHash}>
                  {run.contextSnapshotHash.slice(0, 16)}
                </code>
              </div>
            ) : null}
            {run.tenantProfileHash !== undefined ? (
              <div>
                <span className="muted">tenant profile: </span>
                {run.tenantProfileHash === null ? (
                  <code className="muted">(none)</code>
                ) : (
                  <code title={run.tenantProfileHash}>
                    {run.tenantProfileHash.slice(0, 16)}
                  </code>
                )}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <h2 style={{ marginTop: '2rem' }}>Proposals ({proposals.length})</h2>
      {proposals.length === 0 ? (
        <p className="muted empty">No proposals were staged during this run.</p>
      ) : (
        <ul className="card-list">
          {proposals.map((p) => (
            <li key={p.id}>
              <Link href={`/approvals/${p.id}`} className="card">
                <div className="card-row">
                  <span className={`pill pill-${p.status}`}>{p.status}</span>
                  <span className="card-action">{p.actionType}</span>
                </div>
                <div className="card-summary">{summarize(p)}</div>
                <div className="card-meta">
                  <code>{p.id.slice(0, 8)}</code> ·{' '}
                  {new Date(p.createdAt).toLocaleString()}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <h2 style={{ marginTop: '2rem' }}>Audit trail ({auditRows.length})</h2>
      <AuditTimeline rows={auditRows} />
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-num">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function formatCost(micros?: number): string {
  if (micros === undefined) return '—';
  if (micros === 0) return '$0';
  const cents = micros / 10_000;
  if (cents < 1) return `${micros}µ$`;
  return `$${(cents / 100).toFixed(4)}`;
}

function formatDuration(start: string, end?: string): string {
  if (!end) return 'in progress';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function summarize(p: ProposalRow): string {
  const payload = p.payload as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== 'object') return '(no payload)';
  if (typeof payload.subject === 'string') {
    const to = typeof payload.to === 'string' ? ` to ${payload.to}` : '';
    return `${payload.subject}${to}`;
  }
  if (typeof payload.text === 'string') {
    const channel = typeof payload.channel === 'string' ? ` in ${payload.channel}` : '';
    return `${String(payload.text).slice(0, 90)}${channel}`;
  }
  return JSON.stringify(payload).slice(0, 120);
}
