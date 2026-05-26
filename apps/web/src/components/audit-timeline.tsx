import type { AuditTrailRow } from '@/lib/api';

interface Props {
  rows: AuditTrailRow[];
  // when true, omit per-resource info because the caller already shows the
  // resource header (e.g. the proposal detail page)
  compact?: boolean;
}

const ACTOR_LABEL: Record<string, string> = {
  user: 'human',
  agent: 'agent',
  system: 'system',
};

function statusPill(row: AuditTrailRow): { label: string; cls: string } {
  if (!row.outcome) return { label: 'orphaned', cls: 'pill pill-failed' };
  const s = row.outcome.status;
  if (s === 'executed') return { label: 'executed', cls: 'pill pill-executed' };
  if (s === 'approved') return { label: 'approved', cls: 'pill pill-approved' };
  if (s === 'rejected') return { label: 'rejected', cls: 'pill pill-rejected' };
  if (s === 'failed' || s === 'timeout' || s === 'dropped') {
    return { label: s, cls: 'pill pill-failed' };
  }
  return { label: s, cls: 'pill' };
}

function formatDuration(ms?: number): string | null {
  if (ms === undefined) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function AuditTimeline({ rows, compact = false }: Props) {
  if (rows.length === 0) {
    return <p className="muted empty">(no audit events match this filter)</p>;
  }
  return (
    <ol className="timeline">
      {rows.map((row) => {
        const pill = statusPill(row);
        const dur = formatDuration(row.outcome?.durationMs);
        return (
          <li key={row.intent.id} className="timeline-row">
            <div className="timeline-marker" aria-hidden />
            <div className="timeline-body">
              <div className="timeline-head">
                <span className={pill.cls}>{pill.label}</span>
                <code className="timeline-action">{row.intent.action}</code>
                <span className="timeline-actor">
                  by <strong>{ACTOR_LABEL[row.intent.actorType] ?? row.intent.actorType}</strong>
                  {row.intent.actorId ? (
                    <> · <code>{row.intent.actorId}</code></>
                  ) : null}
                </span>
                {dur ? <span className="timeline-meta">{dur}</span> : null}
              </div>
              <div className="timeline-meta">
                <span>{new Date(row.intent.proposedAt).toLocaleString()}</span>
                {!compact && row.intent.resourceType ? (
                  <>
                    {' · '}
                    <span>
                      {row.intent.resourceType}
                      {row.intent.resourceId ? (
                        <>
                          {' '}
                          <code>{row.intent.resourceId.slice(0, 8)}</code>
                        </>
                      ) : null}
                    </span>
                  </>
                ) : null}
                {row.intent.payloadHash ? (
                  <>
                    {' · payload '}
                    <code title={row.intent.payloadHash}>
                      {row.intent.payloadHash.slice(0, 12)}
                    </code>
                  </>
                ) : null}
                {row.outcome?.resultHash ? (
                  <>
                    {' · result '}
                    <code title={row.outcome.resultHash}>
                      {row.outcome.resultHash.slice(0, 12)}
                    </code>
                  </>
                ) : null}
              </div>
              {row.outcome?.errorText ? (
                <div className="timeline-error">{row.outcome.errorText}</div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
