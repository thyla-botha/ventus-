import Link from 'next/link';
import { listProposals, type ProposalRow, type ProposalStatus } from '@/lib/api';

const STATUS_TABS: { key: ProposalStatus | 'all'; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'executing', label: 'Executing' },
  { key: 'executed', label: 'Executed' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'failed', label: 'Failed' },
  { key: 'all', label: 'All' },
];

interface PageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function ApprovalsPage({ searchParams }: PageProps) {
  const { status } = await searchParams;
  const active = (status as ProposalStatus | 'all' | undefined) ?? 'pending';
  const filter = active === 'all' ? undefined : (active as ProposalStatus);

  let proposals: ProposalRow[] = [];
  let error: string | null = null;
  try {
    proposals = await listProposals(filter);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>Approval inbox</h1>
          <p className="muted">Review drafts staged by your Tier&nbsp;2 agents before they go out.</p>
        </div>
        <Link href="/" className="btn-ghost">&larr; home</Link>
      </header>

      <nav className="tabs">
        {STATUS_TABS.map((tab) => {
          const href =
            tab.key === 'pending'
              ? { pathname: '/approvals' as const }
              : { pathname: '/approvals' as const, query: { status: tab.key } };
          const isActive = (tab.key === 'pending' && !status) || tab.key === active;
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
      ) : proposals.length === 0 ? (
        <p className="muted empty">No proposals with this status.</p>
      ) : (
        <ul className="card-list">
          {proposals.map((p) => (
            <li key={p.id}>
              <Link href={`/approvals/${p.id}`} className="card">
                <div className="card-row">
                  <span className={`pill pill-${p.status}`}>{p.status}</span>
                  <span className="card-action">{p.actionType}</span>
                  <span className="card-conf">
                    confidence&nbsp;
                    {p.confidence !== undefined ? p.confidence.toFixed(2) : '—'}
                  </span>
                </div>
                <div className="card-summary">{summarize(p)}</div>
                <div className="card-meta">
                  <code>{p.id.slice(0, 8)}</code> · agent <code>{p.agentId}</code> ·{' '}
                  {new Date(p.createdAt).toLocaleString()}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
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
