import Link from 'next/link';
import {
  getPricingCoverage,
  getRuntimeDrift,
  getTenantProfile,
  type PricingCoverageReport,
  type RuntimeDriftReport,
  type TenantProfile,
} from '@/lib/api';
import {
  clearProfileAction,
  clearRuntimeAction,
  saveProfileAction,
  saveRuntimeAction,
} from './actions';

// /settings — admin-facing tenant config surface.
//
// Three sections, all behind the same admin trust header until real auth:
//   1. Tenant profile  — the prompt context block injected into every run
//   2. Runtime override — per-tenant {provider, model} pin (or "use default")
//   3. Admin diagnostics — pricing coverage + runtime drift, read-only
//
// We pull everything in parallel on the server (Promise.allSettled, not all,
// so one broken endpoint doesn't blank the entire page — a 5xx on /admin/*
// after a config change is exactly when you want to see the *other* sections
// to fix it).

interface PageProps {
  searchParams: Promise<{ ok?: string; error?: string }>;
}

interface LoadedState {
  profile: TenantProfile | null;
  profileError: string | null;
  pricing: PricingCoverageReport | null;
  pricingError: string | null;
  drift: RuntimeDriftReport | null;
  driftError: string | null;
}

async function load(): Promise<LoadedState> {
  const [pRes, prRes, drRes] = await Promise.allSettled([
    getTenantProfile(),
    getPricingCoverage(),
    getRuntimeDrift(),
  ]);
  return {
    profile: pRes.status === 'fulfilled' ? pRes.value : null,
    profileError: pRes.status === 'rejected' ? toMessage(pRes.reason) : null,
    pricing: prRes.status === 'fulfilled' ? prRes.value : null,
    pricingError: prRes.status === 'rejected' ? toMessage(prRes.reason) : null,
    drift: drRes.status === 'fulfilled' ? drRes.value : null,
    driftError: drRes.status === 'rejected' ? toMessage(drRes.reason) : null,
  };
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default async function SettingsPage({ searchParams }: PageProps) {
  const { ok, error } = await searchParams;
  const state = await load();
  const { profile, pricing, drift } = state;

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="muted">
            Tenant configuration. Profile + runtime writes are admin-gated.
          </p>
        </div>
        <Link href="/" className="btn-ghost">&larr; home</Link>
      </header>

      {ok ? <div className="panel"><strong>Saved.</strong> {humanOk(ok)}</div> : null}
      {error ? (
        <div className="error">
          <strong>Action failed.</strong>
          <pre>{decodeURIComponent(error)}</pre>
        </div>
      ) : null}

      <section className="panel">
        <h2>Tenant profile</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          A bounded context block injected into every agent run&apos;s system prompt.
          Editing this is effectively editing the org-wide prompt — only admins can write.
        </p>
        {state.profileError ? (
          <div className="error">
            <strong>Could not load profile.</strong>
            <pre>{state.profileError}</pre>
          </div>
        ) : (
          <form action={saveProfileAction} className="action-row">
            <div className="form-field">
              <label className="form-label" htmlFor="profile-body">Profile body</label>
              <textarea
                id="profile-body"
                name="body"
                rows={8}
                placeholder="e.g. 'Always sign emails as Acme Realty. Replies should be under 80 words. Never quote price without legal sign-off.'"
                defaultValue={profile?.body ?? ''}
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">Save profile</button>
              {profile ? (
                <button
                  type="submit"
                  className="btn btn-danger"
                  formAction={clearProfileAction}
                >
                  Clear
                </button>
              ) : null}
              {profile ? (
                <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                  hash <code>{profile.contentHash.slice(0, 12)}</code> · updated{' '}
                  {new Date(profile.updatedAt).toLocaleString()}
                  {profile.updatedBy ? ` by ${profile.updatedBy}` : ''}
                </span>
              ) : (
                <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                  no profile set — runs use the bare skill prompt
                </span>
              )}
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>Runtime override</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Pin this tenant to a specific provider + model. Leave unset to use each
          skill&apos;s declared default. If the named provider is not registered the
          next run will <strong>503 fail-closed</strong> rather than silently
          falling back — by design, see runtime-drift below.
        </p>
        {state.profileError ? null : (
          <form action={saveRuntimeAction} className="action-row">
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="form-field" style={{ flex: '1 1 200px' }}>
                <label className="form-label" htmlFor="rt-provider">Provider</label>
                <input
                  id="rt-provider"
                  name="provider"
                  className="text-input"
                  placeholder="e.g. anthropic, openrouter, ollama"
                  defaultValue={profile?.runtime?.provider ?? ''}
                  maxLength={64}
                />
              </div>
              <div className="form-field" style={{ flex: '1 1 280px' }}>
                <label className="form-label" htmlFor="rt-model">Model</label>
                <input
                  id="rt-model"
                  name="model"
                  className="text-input"
                  placeholder="e.g. anthropic/claude-opus-4-7, openrouter/auto"
                  defaultValue={profile?.runtime?.model ?? ''}
                  maxLength={64}
                />
              </div>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">Save runtime</button>
              {profile?.runtime ? (
                <button
                  type="submit"
                  className="btn btn-danger"
                  formAction={clearRuntimeAction}
                >
                  Use default
                </button>
              ) : null}
              {profile?.runtime ? (
                <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                  updated{' '}
                  {profile.runtimeUpdatedAt
                    ? new Date(profile.runtimeUpdatedAt).toLocaleString()
                    : '—'}
                  {profile.runtimeUpdatedBy ? ` by ${profile.runtimeUpdatedBy}` : ''}
                </span>
              ) : (
                <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                  no override — using skill defaults
                </span>
              )}
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>Pricing coverage</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Models referenced by registered skills or tenant runtime overrides.
          Boot will refuse to start under <code>VENTUS_REQUIRE_PRICED_MODELS=1</code>{' '}
          if any entry is unpriced.
        </p>
        {state.pricingError ? (
          <div className="error">
            <strong>Could not load pricing coverage.</strong>
            <pre>{state.pricingError}</pre>
          </div>
        ) : pricing ? (
          <PricingTable report={pricing} />
        ) : null}
      </section>

      <section className="panel">
        <h2>Runtime drift</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Tenants whose stored runtime override points at a provider that is no
          longer registered. Their next run would fail-closed. Repair by editing
          the runtime above, or by re-registering the provider.
        </p>
        {state.driftError ? (
          <div className="error">
            <strong>Could not load drift report.</strong>
            <pre>{state.driftError}</pre>
          </div>
        ) : drift ? (
          <DriftTable report={drift} />
        ) : null}
      </section>
    </main>
  );
}

function humanOk(code: string): string {
  switch (code) {
    case 'profile-saved': return 'Tenant profile updated.';
    case 'profile-cleared': return 'Tenant profile cleared.';
    case 'runtime-saved': return 'Runtime override updated.';
    case 'runtime-cleared': return 'Runtime override removed; using skill defaults.';
    default: return '';
  }
}

function PricingTable({ report }: { report: PricingCoverageReport }) {
  if (report.entries.length === 0) {
    return <p className="muted empty">No models registered.</p>;
  }
  return (
    <>
      <p>
        <span className={`pill ${report.ok ? 'pill-executed' : 'pill-failed'}`}>
          {report.ok ? 'ok' : `${report.unpricedCount} unpriced`}
        </span>
        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
          {report.entries.length} entries total
        </span>
      </p>
      <table className="settings-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Identifier</th>
            <th>Provider</th>
            <th>Model</th>
            <th>Priced</th>
          </tr>
        </thead>
        <tbody>
          {report.entries.map((e, i) => (
            <tr key={`${e.source}:${e.identifier}:${e.model}:${i}`}>
              <td>{e.source}</td>
              <td><code>{e.identifier}</code></td>
              <td><code>{e.provider ?? '—'}</code></td>
              <td><code>{e.model}</code></td>
              <td>
                <span className={`pill ${e.priced ? 'pill-executed' : 'pill-failed'}`}>
                  {e.priced ? 'priced' : 'missing'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function DriftTable({ report }: { report: RuntimeDriftReport }) {
  const registered = report.registeredProviders.join(', ') || '(none)';
  if (report.entries.length === 0) {
    return (
      <>
        <p>
          <span className="pill pill-executed">no drift</span>
        </p>
        <p className="muted" style={{ fontSize: 12 }}>
          Registered providers: <code>{registered}</code>
        </p>
      </>
    );
  }
  return (
    <>
      <p>
        <span className="pill pill-failed">{report.entries.length} drifting</span>
        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
          registered: <code>{registered}</code>
        </span>
      </p>
      <table className="settings-table">
        <thead>
          <tr>
            <th>Tenant</th>
            <th>Pinned provider</th>
            <th>Model</th>
            <th>Updated</th>
            <th>By</th>
          </tr>
        </thead>
        <tbody>
          {report.entries.map((e) => (
            <tr key={e.tenantId}>
              <td><code>{e.tenantId.slice(0, 8)}</code></td>
              <td><code>{e.provider}</code></td>
              <td><code>{e.model}</code></td>
              <td>
                {e.runtimeUpdatedAt
                  ? new Date(e.runtimeUpdatedAt).toLocaleString()
                  : '—'}
              </td>
              <td>{e.runtimeUpdatedBy ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
