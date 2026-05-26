import Link from 'next/link';
import { listSkills, type SkillView } from '@/lib/api';
import { createRunAction } from '../actions';

interface PageProps {
  searchParams: Promise<{ error?: string; skill?: string }>;
}

// Map the short codes the server action redirects with into user-facing
// messages. Keeping raw upstream errors out of the URL avoids leaking
// connectivity detail into browser history and shared screenshots.
const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Pick a skill and write a message.',
  validation: 'The API rejected the request. Check your message length and try again.',
  notfound: 'That skill no longer exists — refresh the page.',
  server: 'Could not reach the API. Check that the server is running.',
};

// /runs/new — pick a skill, type a user message, fire the agent loop. The
// page is fully server-rendered: the form submits to a server action that
// POSTs /v1/runs and redirects to the detail page on success.

export default async function NewRunPage({ searchParams }: PageProps) {
  const { error, skill: preselected } = await searchParams;
  const errorMessage = error ? ERROR_MESSAGES[error] ?? 'Something went wrong.' : null;

  let skills: SkillView[] = [];
  let listError: string | null = null;
  try {
    skills = await listSkills();
  } catch (e) {
    listError = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>New run</h1>
          <p className="muted">
            Pick a skill, give it a message, and start a run. The agent loop
            executes server-side — you can watch it from the detail page.
          </p>
        </div>
        <Link href="/runs" className="btn-ghost">&larr; runs</Link>
      </header>

      {listError ? (
        <div className="error">
          <strong>Could not load skills.</strong>
          <pre>{listError}</pre>
        </div>
      ) : skills.length === 0 ? (
        <p className="muted empty">
          No skills are configured for this deployment. Add one under{' '}
          <code>skills/</code> and restart the API.
        </p>
      ) : (
        <form action={createRunAction} className="run-form">
          {errorMessage ? (
            <div className="error">
              <strong>Could not start run.</strong>
              <p style={{ margin: '4px 0 0' }}>{errorMessage}</p>
            </div>
          ) : null}

          <fieldset>
            <legend>Skill</legend>
            <ul className="skill-picker">
              {skills.map((s, i) => {
                const checked = preselected
                  ? s.name === preselected
                  : i === 0;
                return (
                  <li key={s.name}>
                    <label className="skill-option">
                      <input
                        type="radio"
                        name="skillName"
                        value={s.name}
                        defaultChecked={checked}
                        required
                      />
                      <div>
                        <div className="skill-option-head">
                          <code>{s.name}</code>{' '}
                          <span className="muted">
                            tier {s.tier} · {s.model}
                          </span>
                        </div>
                        <div className="skill-option-desc muted">
                          {s.description}
                        </div>
                        <div className="skill-option-meta muted">
                          tools: {s.allowedTools.join(', ') || '(none)'} · max{' '}
                          {s.maxSteps} steps · ceiling{' '}
                          {s.costCeilingCents !== null
                            ? `$${(s.costCeilingCents / 100).toFixed(2)}`
                            : 'none'}
                        </div>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          <label className="form-field">
            <span className="form-label">User message</span>
            <textarea
              name="message"
              rows={6}
              required
              minLength={1}
              placeholder="Describe what you want the agent to do."
              defaultValue=""
            />
          </label>

          <div className="form-actions">
            <button type="submit" className="btn-primary">
              Start run
            </button>
            <Link href="/runs" className="btn-ghost">cancel</Link>
          </div>
        </form>
      )}
    </main>
  );
}
