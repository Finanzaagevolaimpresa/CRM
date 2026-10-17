'use server';

import { headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { assertOrdinaryEmailRequestOrigin } from './ordinary-email-request-contract';
import { refreshStoredOrdinaryReplies } from './ordinary-email-inbound-store';

/** Current native reader only. No step-up, connector call or mailbox intake. */
export async function refreshOrdinaryRepliesAction(input: unknown): Promise<'UPDATED' | 'MORE' | 'CHECK_CURRENT'> {
  try {
    const session = await requirePermission('practice_communications.read'), h = await headers();
    assertOrdinaryEmailRequestOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site') }, process.env);
    const result = await refreshStoredOrdinaryReplies(prisma,session,input);
    revalidatePath('/communications');
    return result.more ? 'MORE' : 'UPDATED';
  } catch (error) {
    unstable_rethrow(error);
    return 'CHECK_CURRENT';
  }
}
