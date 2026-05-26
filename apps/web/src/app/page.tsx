import Link from 'next/link';

export default function Home() {
  return (
    <main className="hero">
      <h1>Ventus</h1>
      <p className="muted">
        Multi-tenant agentic operations platform. Tier&nbsp;2 agents draft outbound actions —
        emails, Slack replies, ticket updates — and stage them for human approval.
        Every decision and every execution lands in a tamper-evident audit log.
      </p>
      <div className="hero-cta-row">
        <Link href={{ pathname: '/approvals' as const }} className="cta">
          Approval inbox &rarr;
        </Link>
        <Link href={{ pathname: '/runs' as const }} className="cta cta-ghost">
          Runs &rarr;
        </Link>
        <Link href={{ pathname: '/audit' as const }} className="cta cta-ghost">
          Audit trail &rarr;
        </Link>
      </div>
    </main>
  );
}
