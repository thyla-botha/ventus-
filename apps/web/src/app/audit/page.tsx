import Link from 'next/link';
import { listAuditTrail, type AuditTrailRow } from '@/lib/api';
import { AuditTimeline } from '@/components/audit-timeline';

interface PageProps {
  searchParams: Promise<{ resourceType?: string; runId?: string; limit?: string }>;
}

export default async function AuditPage({ searchParams }: PageProps) {
  const { resourceType, runId, limit } = await searchParams;
  const parsedLimit = limit ? Number(limit) : 100;

  let rows: AuditTrailRow[] = [];
  let error: string | null = null;
  try {
    rows = await listAuditTrail({
      resourceType,
      runId,
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const counts = {
    total: rows.length,
    executed: rows.filter((r) => r.outcome?.status === 'executed').length,
    approved: rows.filter((r) => r.outcome?.status === 'approved').length,
    rejected: rows.filter((r) => r.outcome?.status === 'rejected').length,
    failed: rows.filter(
      (r) => r.outcome?.status === 'failed' || !r.outcome,
    ).length,
  };

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>Audit trail</h1>
          <p className="muted">
            Every agent step, human decision, and system execution. Two-phase
            (intent + outcome) — orphaned intents surface here too.
          </p>
        </div>
        <Link href="/" className="btn-ghost">&larr; home</Link>
      </header>

      <nav className="tabs">
        <Link
          href={{ pathname: '/audit' as const }}
          className={!resourceType ? 'tab tab-active' : 'tab'}
        >
          All
        </Link>
        <Link
          href={{ pathname: '/audit' as const, query: { resourceType: 'proposal' } }}
          className={resourceType === 'proposal' ? 'tab tab-active' : 'tab'}
        >
          Proposals
        </Link>
      </nav>

      {error ? (
        <div className="error">
          <strong>API error.</strong>
          <pre>{error}</pre>
        </div>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <div className="stat-num">{counts.total}</div>
              <div className="stat-label">total</div>
            </div>
            <div className="stat">
              <div className="stat-num">{counts.approved}</div>
              <div className="stat-label">approved</div>
            </div>
            <div className="stat">
              <div className="stat-num">{counts.executed}</div>
              <div className="stat-label">executed</div>
            </div>
            <div className="stat">
              <div className="stat-num">{counts.rejected}</div>
              <div className="stat-label">rejected</div>
            </div>
            <div className="stat">
              <div className="stat-num">{counts.failed}</div>
              <div className="stat-label">failed / orphaned</div>
            </div>
          </div>

          <AuditTimeline rows={rows} />
        </>
      )}
    </main>
  );
}
