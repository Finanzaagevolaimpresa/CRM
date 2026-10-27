'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { previewHistoricalLeadContact, confirmHistoricalLeadContact, readHistoricalLeadContactOutcome } from './commercial-lead-historical-contact-storage';
import { previewHistoricalLeadConversion, readHistoricalLeadConversionOutcome } from './commercial-lead-historical-contact-storage';
import { historicalConversionInput } from './commercial-lead-historical-contact-contract';
import { convertCommercialLeadInboxItem } from './commercial-lead-inbox';
import type { HistoricalConversionViewResult } from './commercial-lead-historical-view';
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

export async function prepareHistoricalConversionAction(raw: unknown): Promise<HistoricalConversionViewResult> {
  try {
    const current = await actor(), key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) return { state: 'DENIED', message: 'Conversione non disponibile.' };
    return { state: 'PREVIEW', preview: await previewHistoricalLeadConversion(prisma, current, raw, key) };
  } catch { return { state: 'DENIED', message: 'Conversione non disponibile con lo stato o i permessi correnti.' }; }
}
export async function saveHistoricalConversionAction(raw: unknown): Promise<HistoricalConversionViewResult> {
  try {
    const current = await actor();
    const request = z.object({ token: z.string().max(16_000).regex(/^[A-Za-z0-9_-]+$/u), confirmed: z.literal(true) }).strict().parse(raw);
    // Extract only routing identifiers. The exact signature, current source,
    // session and expiry are checked again in the existing N14 transaction.
    const envelope = z.object({ payload: z.object({ input: z.record(z.string(), z.unknown()) }) })
      .parse(JSON.parse(Buffer.from(request.token, 'base64url').toString('utf8')));
    const { protocol, ...data } = envelope.payload.input;
    if (protocol !== 'N14_HISTORICAL_CONVERSION_V1') throw new Error('N14_HISTORY_DENIED');
    const input = historicalConversionInput(data), key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) throw new Error('N14_HISTORY_DENIED');
    await convertCommercialLeadInboxItem(prisma, { leadId: input.leadId, actor: current,
      expectedInboxVersion: input.expectedInboxVersion, clientType: input.clientType,
      historicalContact: { commandId: input.commandId, contactId: input.contactId, expectedAssignmentId: input.expectedAssignmentId },
      historicalPreview: { key, token: request.token } });
    const result = await readHistoricalLeadConversionOutcome(prisma, current, { leadId: input.leadId, commandId: input.commandId });
    if (result.state !== 'CONVERTED') throw new Error('N14_HISTORY_UNCERTAIN');
    revalidatePath(`/leads/${input.leadId}`); revalidatePath('/leads/inbox'); revalidatePath('/clients');
    return { state: 'CONVERTED', receipt: { commandId: input.commandId, clientId: result.clientId,
      recordedAt: result.recordedAt, basis: result.basis } };
  } catch { return { state: 'DENIED', message: 'Esito da verificare: non ripetere la conversione.' }; }
}
export async function checkHistoricalConversionAction(raw: unknown): Promise<HistoricalConversionViewResult> {
  try {
    const lookup = z.object({ leadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u), commandId: z.string().uuid() }).strict().parse(raw);
    const result = await readHistoricalLeadConversionOutcome(prisma, await actor(), lookup);
    return result.state === 'CONVERTED' ? { state: 'CONVERTED', receipt: { commandId: lookup.commandId,
      clientId: result.clientId, recordedAt: result.recordedAt, basis: result.basis } }
      : { state: 'NOT_OBSERVED', message: 'Decisione non osservata: non ripetere la conversione.' };
  } catch { return { state: 'DENIED', message: 'Esito non consultabile con i permessi correnti.' }; }
}
