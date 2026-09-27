'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { requireEnforcedPrivilegedMutation } from './privileged-access';
import { ApprovedCommunicationError, communicationContextSchema } from './approved-communication-contract';
import { saveApprovedMessageDraft, submitApprovedMessage, approveExactMessage, recordManualMessageEvidence,
  configureCommunicationMailbox, qualifyCommunicationMailbox, acquireManualReply, linkAmbiguousReply } from './approved-communications';

function value(form: FormData, name: string) { return String(form.get(name) ?? ''); }
function addresses(form: FormData, name: string) { return value(form, name).split(/[,;\r\n]+/).map(item => item.trim()).filter(Boolean); }
async function origin() {
  const h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new ApprovedCommunicationError('DENIED');
}
export async function mutateApprovedMessageAction(form: FormData) {
  const session = await requirePermission('practice_communications.read');
  await origin();
  const context = communicationContextSchema.parse({ kind: value(form, 'contextKind'), id: value(form, 'contextId') });
  const target = `/communications?kind=${context.kind}&practice=${encodeURIComponent(context.id)}`;
  const intent = value(form, 'intent');
  if (intent === 'approve' || (intent === 'evidence' && value(form, 'reconciliation') === 'true'))
    await requireEnforcedPrivilegedMutation(session, 'M4_MESSAGE_APPROVAL');
  let errorCode: string | null = null;
  try {
    if (intent === 'draft') await saveApprovedMessageDraft(prisma, session, {
      messageId: value(form, 'messageId'), expectedRevision: Number(value(form, 'expectedRevision')), context,
      mailboxId: value(form, 'mailboxId'), replyTo: value(form, 'replyTo'), to: addresses(form, 'to'), cc: addresses(form, 'cc'), bcc: addresses(form, 'bcc'),
      subject: value(form, 'subject'), body: value(form, 'body'), attachmentVersionIds: form.getAll('attachmentVersionId').map(String),
      classification: value(form, 'classification'),
    });
    else if (intent === 'submit') await submitApprovedMessage(prisma, session, { messageId: value(form, 'messageId'), expectedRevision: Number(value(form, 'expectedRevision')), snapshotHash: value(form, 'snapshotHash') });
    else if (intent === 'approve') {
      if (value(form, 'exactApproval') !== 'APPROVO_IL_MESSAGGIO_ESATTO') throw new ApprovedCommunicationError('DENIED');
      await approveExactMessage(prisma, session, { messageId: value(form, 'messageId'), expectedRevision: Number(value(form, 'expectedRevision')), snapshotHash: value(form, 'snapshotHash') });
    } else if (intent === 'evidence') await recordManualMessageEvidence(prisma, session, {
      messageId: value(form, 'messageId'), attemptId: value(form, 'attemptId'), reconciliation: value(form, 'reconciliation') === 'true',
      evidence: { method: 'MANUAL_DECLARATION', outcome: value(form, 'outcome'), occurredAt: value(form, 'occurredAt'), reference: value(form, 'reference'), note: value(form, 'note') },
    });
    else throw new ApprovedCommunicationError('INVALID');
  } catch (error) {
    if (!(error instanceof ApprovedCommunicationError)) throw error;
    errorCode = error.code;
  }
  revalidatePath('/communications');
  redirect(`${target}&result=${errorCode ?? 'RECORDED'}`);
}

export async function mutateCommunicationAdministrationAction(form: FormData) {
  const session = await requirePermission('practice_communications.read');
  await origin();
  const intent = value(form, 'intent');
  if (['configure', 'TEST', 'ENABLE', 'DISABLE'].includes(intent)) await requireEnforcedPrivilegedMutation(session, 'M4_MAILBOX_QUALIFICATION');
  let errorCode: string | null = null;
  try {
    const mailboxId = value(form, 'mailboxId'), expectedRevision = Number(value(form, 'expectedRevision'));
    if (intent === 'configure') await configureCommunicationMailbox(prisma, session, { mailboxId, expectedRevision,
      kind: value(form, 'kind'), canonicalMailboxId: value(form, 'canonicalMailboxId') || null, providerReference: value(form, 'providerReference'),
      responsibleUserId: value(form, 'responsibleUserId'), configurationReference: value(form, 'configurationReference'),
      canSend: form.has('canSend'), canReceive: form.has('canReceive'), restricted: form.has('restricted'),
    });
    else if (['TEST', 'ENABLE', 'DISABLE'].includes(intent)) await qualifyCommunicationMailbox(prisma, session, { mailboxId, expectedRevision,
      action: intent, ...(intent === 'TEST' ? { testReference: value(form, 'testReference') } : {}) });
    else if (intent === 'reply') await acquireManualReply(prisma, session, { mailboxId, externalMessageId: value(form, 'externalMessageId'),
      inReplyTo: value(form, 'inReplyTo') || null, sender: value(form, 'sender'), subject: value(form, 'subject'), body: value(form, 'body'),
      receivedAt: value(form, 'receivedAt'), evidenceReference: value(form, 'evidenceReference') });
    else if (intent === 'link') await linkAmbiguousReply(prisma, session, { replyId: value(form, 'replyId'), messageId: value(form, 'messageId'), reason: value(form, 'reason') });
    else throw new ApprovedCommunicationError('INVALID');
  } catch (error) {
    if (!(error instanceof ApprovedCommunicationError)) throw error;
    errorCode = error.code;
  }
  revalidatePath('/communications'); revalidatePath('/settings/communications');
  redirect(`/settings/communications?result=${errorCode ?? 'RECORDED'}`);
}
