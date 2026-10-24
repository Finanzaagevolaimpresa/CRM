'use server';

import { headers, cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { technicalTargetReference } from './technical-assignment-display';
import { technicalAssignmentReference } from './technical-assignment-decision';
import { TechnicalAssignmentError } from './technical-assignment-transaction';
import { documentUploadMaxBytes } from './document-upload-contract';
import { previewTechnicalUpload, confirmTechnicalUpload, readTechnicalUploadOutcome } from './technical-upload-service';
import { previewTechnicalUploadReview, confirmTechnicalUploadReview, readTechnicalUploadReviewOutcome } from './technical-upload-review-service';
import { technicalUploadPath, technicalUploadReviewPath } from './technical-upload-display';
import type { TechnicalUploadState } from './technical-upload-ui-state';

function json(form: FormData, name: string) {
  const raw = form.get(name);
  if (typeof raw !== 'string' || raw.length > 24_000) throw new TechnicalAssignmentError('DENIED');
  return JSON.parse(raw) as unknown;
}
async function origin() {
  const h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new TechnicalAssignmentError('DENIED');
}
async function file(form: FormData) {
  const value = form.get('file');
  if (!(value instanceof File) || value.size < 1 || value.size > documentUploadMaxBytes) throw new TechnicalAssignmentError('DENIED');
  return { name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) };
}
const failure = (uncertain = false): TechnicalUploadState => ({ ok: false, uncertain, message: uncertain
  ? 'Esito non confermato. Verifica la ricevuta senza ripetere l’operazione. Nessun nuovo comando viene avviato automaticamente.'
  : 'Operazione non disponibile: controlla formato, dimensione e quote, oppure ricarica per verificare incarico e permessi correnti.' });
export async function prepareTechnicalUpload(_state: TechnicalUploadState, form: FormData): Promise<TechnicalUploadState> {
  const session = await requireSession();
  try { await origin(); const value = await file(form);
    const uploadPreview = await previewTechnicalUpload(prisma, session, technicalTargetReference.parse(json(form, 'target')), json(form, 'command'), value.name, value.bytes);
    return { ok: true, message: 'Controlla il file e il deposito privato prima di confermare.', uploadPreview };
  } catch { return failure(); }
}
export async function saveTechnicalUpload(_state: TechnicalUploadState, form: FormData): Promise<TechnicalUploadState> {
  const session = await requireSession();
  try { await origin(); const target = technicalTargetReference.parse(json(form, 'target')), value = await file(form);
    await confirmTechnicalUpload(prisma, session, target, json(form, 'command'), String(form.get('token') ?? ''), value.bytes, form.get('confirmed') === 'on');
    revalidatePath(technicalUploadPath(target));
    return { ok: true, recorded: true, message: 'Deposito privato registrato. Il file attende la revisione dell’Admin.' };
  } catch { return failure(true); }
}
export async function checkTechnicalUpload(_state: TechnicalUploadState, form: FormData): Promise<TechnicalUploadState> {
  const session = await requireSession();
  try { await origin(); const result = await readTechnicalUploadOutcome(prisma, session, technicalTargetReference.parse(json(form, 'target')), String(form.get('commandId') ?? ''));
    return result.status === 'RECORDED' ? { ok: true, recorded: true, message: 'Deposito già registrato. Non ripetere il caricamento.' } : failure(true);
  } catch { return failure(true); }
}
export async function prepareTechnicalUploadReview(_state: TechnicalUploadState, form: FormData): Promise<TechnicalUploadState> {
  const session = await requireSession();
  try { await origin(); const reviewPreview = await previewTechnicalUploadReview(prisma, session, technicalAssignmentReference.parse(json(form, 'reference')), json(form, 'command'));
    return { ok: true, message: 'Verifica la decisione sul file esatto.', reviewPreview };
  } catch { return failure(); }
}
export async function saveTechnicalUploadReview(_state: TechnicalUploadState, form: FormData): Promise<TechnicalUploadState> {
  const session = await requireSession();
  await requireEnforcedPrivilegedMutation(session, 'TECHNICAL_ASSIGNMENT_MANAGE');
  try { await origin(); const ref = technicalAssignmentReference.parse(json(form, 'reference'));
    const store = await cookies(), key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) throw new TechnicalAssignmentError('UNAVAILABLE');
    await confirmTechnicalUploadReview(prisma, session, { key,
      sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' }, ref, json(form, 'command'), String(form.get('token') ?? ''), form.get('confirmed') === 'on');
    revalidatePath(technicalUploadReviewPath(ref)); revalidatePath(technicalUploadPath(ref));
    return { ok: true, recorded: true, message: 'Revisione registrata. Il file resta nel deposito privato; nessun documento è stato pubblicato o inviato.' };
  } catch { return failure(true); }
}
export async function checkTechnicalUploadReview(_state: TechnicalUploadState, form: FormData): Promise<TechnicalUploadState> {
  const session = await requireSession();
  try { await origin(); const result = await readTechnicalUploadReviewOutcome(prisma, session, technicalAssignmentReference.parse(json(form, 'reference')), String(form.get('commandId') ?? ''));
    return result.status === 'RECORDED' ? { ok: true, recorded: true, message: 'Revisione già registrata. Non ripetere la decisione.' } : failure(true);
  } catch { return failure(true); }
}
