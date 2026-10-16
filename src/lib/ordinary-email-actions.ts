'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { previewOrdinaryEmailFromRequest, rejectOrdinaryEmailFromRequest } from './ordinary-email-server-candidate';
import type { OrdinaryEmailPreviewResult, OrdinaryEmailRefusalResult } from './ordinary-email-ui-contract';

// Deliberately no send action or default connector: ordinary transport still
// needs its own qualified server integration. Neither M4 nor a preview sends.
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
