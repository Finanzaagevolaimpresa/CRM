'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { previewHistoricalLeadContact, confirmHistoricalLeadContact, readHistoricalLeadContactOutcome } from './commercial-lead-historical-contact-storage';
import type { HistoricalContactViewResult, HistoricalContactViewReceipt } from './commercial-lead-historical-view';

const denied = (): HistoricalContactViewResult => ({ state: 'DENIED', message: 'Operazione non disponibile con lo stato o i permessi correnti.' });
async function actor() {
  const session = await requireSession(), h = await headers();
  if (!session.sessionId || !isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new Error('N14_HISTORY_DENIED');
  return { userId: session.userId, sessionId: session.sessionId };
}
function receiptView(receipt: HistoricalContactViewReceipt): HistoricalContactViewReceipt {
  return { id: receipt.id, input: receipt.input, recordedAt: receipt.recordedAt, inboxVersionAfter: receipt.inboxVersionAfter };
}
export async function prepareHistoricalContactAction(raw: unknown): Promise<HistoricalContactViewResult> {
  try {
    const current = await actor(), key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) return denied();
    return { state: 'PREVIEW', preview: await previewHistoricalLeadContact(prisma, current, raw, key) };
  } catch { return denied(); }
}
export async function saveHistoricalContactAction(raw: unknown): Promise<HistoricalContactViewResult> {
  try {
    const current = await actor();
    const input = z.object({ token: z.string().max(16_000), confirmed: z.literal(true) }).strict().parse(raw);
    const key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) return denied();
    const result = await confirmHistoricalLeadContact(prisma, current, key, input.token, input.confirmed);
    revalidatePath(`/leads/${result.receipt.input.leadId}`);
    return { state: 'RECORDED', receipt: receiptView(result.receipt) };
  } catch { return denied(); }
}
export async function checkHistoricalContactAction(raw: unknown): Promise<HistoricalContactViewResult> {
  try {
    const current = await actor(), result = await readHistoricalLeadContactOutcome(prisma, current, raw);
    return result.state === 'RECORDED' ? { state: 'RECORDED', receipt: receiptView(result.receipt) }
      : { state: 'NOT_OBSERVED', message: 'Decisione non osservata: non ripetere la registrazione.' };
  } catch { return denied(); }
}
