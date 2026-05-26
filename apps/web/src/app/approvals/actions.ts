'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { decideProposal, executeProposalHttp } from '@/lib/api';

export async function approveAction(id: string, formData: FormData): Promise<void> {
  const comment = (formData.get('comment') as string | null) ?? undefined;
  await decideProposal(id, { verdict: 'approved', comment: comment || undefined });
  revalidatePath('/approvals');
  revalidatePath(`/approvals/${id}`);
}

export async function approveWithEditsAction(id: string, formData: FormData): Promise<void> {
  const rawEdited = (formData.get('editedPayload') as string | null) ?? '';
  const comment = (formData.get('comment') as string | null) ?? undefined;

  let editedPayload: unknown;
  try {
    editedPayload = JSON.parse(rawEdited);
  } catch {
    redirect(`/approvals/${id}?error=invalid-json`);
  }

  // Verdict stays 'approved' on the wire; the API flips it to 'edited' when
  // editedPayload is present so the store records both the agent's draft and
  // the reviewer's correction (and the executor reads editedPayload via
  // effectivePayload).
  await decideProposal(id, {
    verdict: 'approved',
    comment: comment || undefined,
    editedPayload,
  });
  revalidatePath('/approvals');
  revalidatePath(`/approvals/${id}`);
}

export async function rejectAction(id: string, formData: FormData): Promise<void> {
  const comment = (formData.get('comment') as string | null) ?? undefined;
  await decideProposal(id, { verdict: 'rejected', comment: comment || undefined });
  revalidatePath('/approvals');
  redirect('/approvals');
}

export async function executeAction(id: string): Promise<void> {
  await executeProposalHttp(id);
  revalidatePath('/approvals');
  revalidatePath(`/approvals/${id}`);
}
