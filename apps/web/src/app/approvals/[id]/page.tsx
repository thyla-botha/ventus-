import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProposal, listAuditTrail } from '@/lib/api';
import { AuditTimeline } from '@/components/audit-timeline';
import {
  approveAction,
  approveWithEditsAction,
  rejectAction,
  executeAction,
} from '../actions';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

const ERROR_MESSAGES: Record<string, string> = {
  'invalid-json': 'Edited payload must be valid JSON. Fix the syntax and try again.',
};

export default async function ProposalDetailPage({ params, searchParams }: PageProps) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const proposal = await getProposal(id);
  if (!proposal) notFound();

  const auditRows = await listAuditTrail({
    resourceType: 'proposal',
    resourceId: id,
    limit: 50,
  }).catch(() => []);

  const canDecide = proposal.status === 'pending';
  const canExecute = proposal.status === 'approved';

  const approve = approveAction.bind(null, proposal.id);
  const approveWithEdits = approveWithEditsAction.bind(null, proposal.id);
  const reject = rejectAction.bind(null, proposal.id);
  const execute = executeAction.bind(null, proposal.id);

  const errorMessage = error ? ERROR_MESSAGES[error] ?? null : null;
  const draftJson = JSON.stringify(proposal.payload, null, 2);
  const wasEdited = proposal.decision?.verdict === 'edited';
  const editedJson = wasEdited
    ? JSON.stringify(proposal.decision?.editedPayload, null, 2)
    : null;

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className={`pill pill-${proposal.status}`}>{proposal.status}</span>{' '}
            {proposal.actionType}
          </h1>
          <p className="muted">
            Proposal <code>{proposal.id}</code> · agent <code>{proposal.agentId}</code> · run{' '}
            <code>{proposal.runId}</code>
          </p>
        </div>
        <Link href="/approvals" className="btn-ghost">&larr; inbox</Link>
      </header>

      <section className="grid">
        <div className="panel">
          <h2>Draft payload</h2>
          <pre className="code-block">{JSON.stringify(proposal.payload, null, 2)}</pre>
          {proposal.expectedOutcome ? (
            <p className="muted">
              <strong>Expected outcome:</strong> {proposal.expectedOutcome}
            </p>
          ) : null}
          {proposal.confidence !== undefined ? (
            <p className="muted">
              <strong>Self-rated confidence:</strong> {proposal.confidence.toFixed(2)}
            </p>
          ) : null}
        </div>

        <div className="panel">
          <h2>Evidence</h2>
          {proposal.evidence && proposal.evidence.length > 0 ? (
            <ul className="evidence-list">
              {(proposal.evidence as Array<Record<string, unknown>>).map((ev, i) => (
                <li key={i}>
                  <code>{String(ev.document_id ?? '?')}</code>
                  {ev.quote ? <blockquote>{String(ev.quote)}</blockquote> : null}
                  {ev.rationale ? <p className="muted">{String(ev.rationale)}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">(no evidence cited)</p>
          )}
        </div>
      </section>

      {proposal.decision ? (
        <section className="panel">
          <h2>Decision</h2>
          <p>
            <strong>{proposal.decision.verdict}</strong> by{' '}
            <code>{proposal.decision.approverId}</code> at{' '}
            {new Date(proposal.decision.decidedAt).toLocaleString()}
          </p>
          {proposal.decision.comment ? (
            <blockquote>{proposal.decision.comment}</blockquote>
          ) : null}
          {editedJson ? (
            <>
              <p className="muted">
                <strong>Reviewer-edited payload</strong> (used at execution time):
              </p>
              <pre className="code-block">{editedJson}</pre>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="panel">
        <h2>Audit trail</h2>
        <AuditTimeline rows={auditRows} compact />
      </section>

      <section className="panel actions">
        <h2>Actions</h2>
        {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
        {canDecide ? (
          <>
            <div className="action-row">
              <form action={approve}>
                <input
                  name="comment"
                  type="text"
                  placeholder="optional comment"
                  className="text-input"
                />
                <button type="submit" className="btn btn-primary">
                  Approve as-drafted
                </button>
              </form>
              <form action={reject}>
                <input
                  name="comment"
                  type="text"
                  placeholder="reason for rejection"
                  className="text-input"
                />
                <button type="submit" className="btn btn-danger">
                  Reject
                </button>
              </form>
            </div>

            <details className="edit-block">
              <summary>Approve with edits</summary>
              <form action={approveWithEdits} className="edit-form">
                <p className="muted">
                  Edit the JSON below. The executor will act on this payload,
                  not the agent&apos;s draft. The original draft is preserved in
                  the audit log.
                </p>
                <textarea
                  name="editedPayload"
                  defaultValue={draftJson}
                  className="code-textarea"
                  rows={Math.min(20, Math.max(6, draftJson.split('\n').length + 1))}
                  spellCheck={false}
                />
                <input
                  name="comment"
                  type="text"
                  placeholder="what changed and why"
                  className="text-input"
                />
                <button type="submit" className="btn btn-primary">
                  Approve with edits
                </button>
              </form>
            </details>
          </>
        ) : canExecute ? (
          <div className="action-row">
            <p className="muted">Approved by {proposal.decision?.approverId}. Ready to execute.</p>
            <form action={execute}>
              <button type="submit" className="btn btn-primary">
                Execute now
              </button>
            </form>
          </div>
        ) : (
          <p className="muted">
            No further actions available — this proposal is{' '}
            <strong>{proposal.status}</strong>.
          </p>
        )}
      </section>
    </main>
  );
}
