'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  deleteTenantProfile,
  deleteTenantRuntime,
  setTenantProfile,
  setTenantRuntime,
} from '@/lib/api';

// Server actions for the /settings page. Each one normalises the FormData
// into a typed payload, calls the API client (which sends x-user-role=admin
// because TenantProfile + runtime writes are admin-gated), revalidates the
// page, and redirects with an optional status flag so the UI can render a
// success or error banner.

function safe(s: string): string {
  // Mirrors UNSAFE_CHARS_RE in @ventus/store: rejecting in the client gives
  // the admin a clean error instead of a 400 round-trip. The server still
  // rejects independently — this is just UX.
  return s.replace(/[\x00-\x1F\x7F-\x9F\u2028\u2029]/gu, '');
}

export async function saveProfileAction(formData: FormData): Promise<void> {
  const raw = (formData.get('body') as string | null) ?? '';
  const body = raw.trim();
  if (!body) {
    redirect('/settings?error=profile-empty');
  }
  try {
    await setTenantProfile(safe(body));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`/settings?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath('/settings');
  redirect('/settings?ok=profile-saved');
}

export async function clearProfileAction(): Promise<void> {
  try {
    await deleteTenantProfile();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`/settings?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath('/settings');
  redirect('/settings?ok=profile-cleared');
}

export async function saveRuntimeAction(formData: FormData): Promise<void> {
  const provider = ((formData.get('provider') as string | null) ?? '').trim();
  const model = ((formData.get('model') as string | null) ?? '').trim();
  if (!provider || !model) {
    redirect('/settings?error=runtime-missing-fields');
  }
  try {
    await setTenantRuntime({ provider: safe(provider), model: safe(model) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`/settings?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath('/settings');
  redirect('/settings?ok=runtime-saved');
}

export async function clearRuntimeAction(): Promise<void> {
  try {
    await deleteTenantRuntime();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`/settings?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath('/settings');
  redirect('/settings?ok=runtime-cleared');
}
