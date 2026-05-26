import Link from 'next/link';
import { listRuns, type RunRow, type RunStatus } from '@/lib/api';

const STATUS_TABS: { key: RunStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'completed', label: 'Completed' },
  { key: 'halted', label: 'Halted' },
  { key: 'failed', label: 'Failed' },
];

interface PageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function RunsPage({ searchParams }: PageProps) {
  const { status } = await searchParams;
  const active = (status as RunStatus | 'all' | undefined) ?? 'all';
  const filter = active === 'all' ? undefined : (active as RunStatus);

  let runs: RunRow[] = [];
  let error: string | null = null;
  try {
    runs = await listRuns({ status: filter });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>Runs</h1>
          <p className="muted">
            Every agent execution against this tenant. Click into a run to see
            its proposals, audit trail, and cost.
          </p>
        </div>
        <div className="header-actions">
          <Link href="/runs/new" className="btn-primary">+ new run</Link>
          <Link href="/" className="btn-ghost">&larr; home</Link>
        </div>
      </header>

      <nav className="tabs">
        {STATUS_TABS.map((tab) => {
          const href =
            tab.key === 'all'
              ? { pathname: '/runs' as const }
              : { pathname: '/runs' as const, query: { status: tab.key } };
          const isActive = (tab.key === 'all' && !status) || tab.key === active;
          return (
            <Link key={tab.key} href={href} className={isActive ? 'tab tab-active' : 'tab'}>
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {error ? (
        <div className="error">
          <strong>API error.</strong> Make sure the API is running on{' '}
          <code>http://localhost:8080</code> with{' '}
          <code>VENTUS_DEV_DEFAULT_TENANT=1</code>.
          <pre>{error}</pre>
        </div>
      ) : runs.length === 0 ? (
        <p className="muted empty">No runs with this status.</p>
      ) : (
        <ul className="card-list">
          {runs.map((r) => (
            <li key={r.id}>
              <Link href={`/runs/${r.id}`} className="card">
                <div className="card-row">
                  <span className={`pill pill-run-${r.status}`}>{r.status}</span>
                  <span className="card-action">{r.skillId ?? r.agentId}</span>
                  <span className="card-conf">
                    {r.proposalCount !== undefined ? `${r.proposalCount} proposal(s)` : '—'}{' '}
                    · {formatCost(r.totalCostMicros)}
                  </span>
                </div>
                <div className="card-summary">
                  {r.userMessage ?? <span className="muted">(no user message)</span>}
                </div>
                <div className="card-meta">
                  <code>{r.id.slice(0, 8)}</code> · agent <code>{r.agentId}</code> ·{' '}
                  {r.model ? <><code>{r.model}</code> · </> : null}
                  {new Date(r.startedAt).toLocaleString()}
                  {r.endedAt ? <> · {formatDuration(r.startedAt, r.endedAt)}</> : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function formatCost(micros?: number): string {
  if (micros === undefined) return '—';
  if (micros === 0) return '$0';
  const cents = micros / 10_000;
  if (cents < 1) return `${micros}µ$`;
  return `$${(cents / 100).toFixed(4)}`;
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
