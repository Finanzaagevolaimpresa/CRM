'use server';
import { cookies } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { assertTechnicalServerAction } from './technical-server-guards';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { PrivilegedAdmissionRequired, privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { prepareOperationalProformaEmail, recordOperationalProformaArchive } from './operational-document-delivery';
import { OperationalArchiveTimeError, resolveProformaArchiveTime } from './operational-document-time';

type State = { error: string | null; stepUpRequired?: boolean };
async function save(kind: 'EMAIL' | 'ARCHIVE', form: FormData): Promise<State> {
  const session = await requireSession(); let result;
  try {
    await requireEnforcedPrivilegedMutation(session, 'RECORD_UPDATE_MANAGE', { inline: true });
    const key = await loadActivePrivilegedStepUpKey(prisma); if (!key) throw new Error('SENDER_NOT_READY');
    const jar = await cookies(), proof = { key, sessionToken: jar.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '', stepUpToken: jar.get(privilegedStepUpCookieName)?.value ?? '' };
    const base = { commandId: form.get('commandId'), documentId: form.get('documentId'), contentHash: form.get('contentHash'), confirmed: form.get('confirmed') === 'on' };
    result = kind === 'EMAIL' ? await prepareOperationalProformaEmail(prisma, session, { ...base, mailboxId: form.get('mailboxId'), to: form.get('to'), subject: form.get('subject'), body: form.get('body') }, proof)
      : await recordOperationalProformaArchive(prisma, session, { ...base, folderId: form.get('folderId'), fileUrl: form.get('fileUrl'), pdfSha256: form.get('pdfSha256'),
        evidence: form.get('evidence'), occurredAt: resolveProformaArchiveTime(form.get('occurredAt'), form.get('occurredAtTimeZone'), form.get('occurredAtInstant')),
        folderMembershipConfirmed: form.get('folderMembershipConfirmed') === 'on', accessConfirmed: form.get('accessConfirmed') === 'on' }, proof);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof PrivilegedAdmissionRequired) return { error: error.formState.message, stepUpRequired: error.status === 'required' };
    if (error instanceof OperationalArchiveTimeError) return { error: error.message };
    return { error: kind === 'EMAIL' ? 'Bozza non confermata. Verifica conferma proforma, autorità email, mittente, destinatario e risultato già registrato prima di ripetere.'
      : 'Evidenza non registrata. Verifica cartella attiva del cliente, link del file, hash PDF e data effettiva.' };
  }
  revalidatePath('/document-library/' + result.id); redirect('/document-library/' + result.id);
}
export async function prepareProformaEmailAction(_state: State, form: FormData) {
  await assertTechnicalServerAction('operational-document-delivery-actions:prepareProformaEmailAction');
  return save('EMAIL', form);
}
export async function recordProformaArchiveAction(_state: State, form: FormData) {
  await assertTechnicalServerAction('operational-document-delivery-actions:recordProformaArchiveAction');
  return save('ARCHIVE', form);
}
