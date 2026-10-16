'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { confirmOrdinaryEmailFromRequest, previewOrdinaryEmailFromRequest, rejectOrdinaryEmailFromRequest } from './ordinary-email-server-candidate';
import type { OrdinaryEmailPreviewResult, OrdinaryEmailRefusalResult, OrdinaryEmailSendResult } from './ordinary-email-ui-contract';

// No action creates authority or qualifies transport. M4 and preview do not send.
export async function previewOrdinaryEmailAction(input: unknown): Promise<OrdinaryEmailPreviewResult> {
  try { return { status: 'READY', preview: await previewOrdinaryEmailFromRequest(input) }; }
  catch (error) { unstable_rethrow(error); return { status: 'UNAVAILABLE' }; }
}

export async function rejectOrdinaryEmailAction(input: unknown): Promise<OrdinaryEmailRefusalResult> {
  try {
    const result = await rejectOrdinaryEmailFromRequest(input);
    revalidatePath('/communications');
    return { status: 'REJECTED', revision: result.revision };
  } catch (error) {
    unstable_rethrow(error);
    // A lost transaction result must not cause a second refusal/version. The
    // client discards its preview and reloads persisted state, never retries.
    return { status: 'CHECK_CURRENT' };
  }
}

export async function confirmOrdinaryEmailAction(input: unknown): Promise<OrdinaryEmailSendResult> {
  try {
    const result = await confirmOrdinaryEmailFromRequest(input);
    revalidatePath('/communications');
    return result.status === 'RECORDED' ? { status: 'RECORDED', outcome: result.outcome } : { status: 'CHECK_CURRENT' };
  } catch (error) {
    unstable_rethrow(error);
    // Never infer rollback from a lost result. No client retry or transport
    // detail is returned; the persisted receipt/current state is authoritative.
    return { status: 'CHECK_CURRENT' };
  }
}
