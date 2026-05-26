'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { cancelRun, createRun } from '@/lib/api';

// Server action for POST /v1/runs. On success: revalidate the list and
// redirect into the detail page so the user can watch the loop progress.
// On failure: bounce back to /runs/new with a SHORT error code in the query
// string — the raw error stays in the server log (it can contain backend
// connectivity detail / file paths we don't want in browser history).

const ERROR_CODES = {
  missing: 'missing',      // skill or message not provided
  validation: 'validation', // API rejected the body (400)
  notfound: 'notfound',    // skill not found (404)
  server: 'server',        // unexpected upstream failure
} as const;

export async function createRunAction(formData: FormData): Promise<void> {
  const skillName = (formData.get('skillName') as string | null)?.trim() ?? '';
  const message = (formData.get('message') as string | null)?.trim() ?? '';

  if (!skillName || !message) {
    redirect(`/runs/new?error=${ERROR_CODES.missing}`);
  }

  let runId: string;
  try {
    const run = await createRun({ skillName, message });
    runId = run.id;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('createRunAction failed:', text);
    // Map upstream HTTP status → public error code.
    let code: string = ERROR_CODES.server;
    if (/^400\b/.test(text)) code = ERROR_CODES.validation;
    else if (/^404\b/.test(text)) code = ERROR_CODES.notfound;
    redirect(`/runs/new?error=${code}`);
  }

  revalidatePath('/runs');
  redirect(`/runs/${runId}`);
}

// Server action invoked by the Cancel button on /runs/[id]. Wraps
// POST /v1/runs/:id/cancel. The action revalidates the detail page so the
// auto-refresh picks up the new cancel marker immediately; the actual
// status flip to 'aborted' happens when the agent loop observes the marker.
export async function cancelRunAction(id: string): Promise<void> {
  try {
    await cancelRun(id);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('cancelRunAction failed:', text);
    // 409 (not running) is the common race — refresh will show the new state.
    // Don't crash the action; let revalidate + page re-render report it.
  }
  revalidatePath(`/runs/${id}`);
  revalidatePath('/runs');
}
