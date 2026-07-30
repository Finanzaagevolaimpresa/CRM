'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  approveAiExecutionRequest,
  cancelAiExecutionRequest,
  rejectAiExecutionRequest,
  requestAiExecutionInformation,
  revokeAiExecutionRequest,
} from './ai-execution-authorization';
import { requireSession } from './auth';
import { aiOutputApprovalSchema } from './validation';

function requestId(form: FormData) {
  return aiOutputApprovalSchema.parse({ id: String(form.get('id') ?? '') }).id;
}

function revalidateRequestContext(request: {
  id: string;
  clientId?: string | null;
  projectId?: string | null;
}) {
  revalidatePath('/settings/ai-authorizations');
  revalidatePath(`/settings/ai-authorizations/${request.id}`);
  revalidatePath('/notifications');
  revalidatePath('/dashboard');
  if (request.clientId) revalidatePath(`/clients/${request.clientId}`);
  if (request.projectId) revalidatePath(`/projects/${request.projectId}`);
}

export async function approveAiExecutionRequestAndRefresh(form: FormData) {
  const session = await requireSession();
  const request = await approveAiExecutionRequest(session, requestId(form));
  revalidateRequestContext(request);
}

export async function rejectAiExecutionRequestAndRefresh(form: FormData) {
  const session = await requireSession();
  const request = await rejectAiExecutionRequest(session, requestId(form));
  revalidateRequestContext(request);
}

export async function requestAiExecutionInformationAndRefresh(form: FormData) {
  const session = await requireSession();
  const request = await requestAiExecutionInformation(session, requestId(form));
  revalidateRequestContext(request);
}

export async function revokeAiExecutionRequestAndRefresh(form: FormData) {
  const session = await requireSession();
  const request = await revokeAiExecutionRequest(session, requestId(form));
  revalidateRequestContext(request);
}

export async function cancelAiExecutionRequestAndRedirect(form: FormData) {
  const session = await requireSession();
  const request = await cancelAiExecutionRequest(session, requestId(form));
  revalidateRequestContext(request);
  redirect('/settings/ai-authorizations');
}
