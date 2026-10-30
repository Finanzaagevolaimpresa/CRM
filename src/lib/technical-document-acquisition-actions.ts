'use server';
import { headers, cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, requireEnforcedPrivilegedMutation, PrivilegedAdmissionRequired } from './privileged-access';
import { technicalAssignmentReference } from './technical-assignment-decision';
import { TechnicalAssignmentError } from './technical-assignment-transaction';
import { previewTechnicalDocumentAcquisition, confirmTechnicalDocumentAcquisition, readTechnicalDocumentAcquisitionOutcome } from './technical-document-acquisition-service';
import { technicalUploadReviewPath } from './technical-upload-display';
import type { TechnicalUploadState } from './technical-upload-ui-state';
const denied = () => { throw new TechnicalAssignmentError('DENIED'); };
function json(form: FormData, name: string) {
  const raw = form.get(name); if (typeof raw !== 'string' || raw.length > 24000) return denied();
  return JSON.parse(raw) as unknown;
}
async function origin() {
  const h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) denied();
}
const failure = (uncertain = false): TechnicalUploadState => ({ ok: false, uncertain, message: uncertain
  ? 'Esito non confermato. Verifica la ricevuta del comando originale prima di ripetere l’acquisizione.'
  : 'Acquisizione non disponibile. Ricarica per verificare revisione, incarico, file e permessi correnti.' });
export async function prepareTechnicalAcquisition(_state: TechnicalUploadState, form: FormData): Promise<TechnicalUploadState> {
  const session = await requireSession();
  try { await origin(); const acquisitionPreview = await previewTechnicalDocumentAcquisition(prisma, session,
    technicalAssignmentReference.parse(json(form, 'reference')), json(form, 'command'));
    return { ok: true, message: 'Verifica classificazione e destinazione privata.', acquisitionPreview };
  } catch { return failure(); }
}
export async function saveTechnicalAcquisition(_state: TechnicalUploadState, form: FormData): Promise<TechnicalUploadState> {
  const session = await requireSession();
  try { await requireEnforcedPrivilegedMutation(session, 'TECHNICAL_ASSIGNMENT_MANAGE', { inline: true }); await origin(); const ref = technicalAssignmentReference.parse(json(form, 'reference'));
    const store = await cookies(), key = await loadActivePrivilegedStepUpKey(prisma); if (!key) return denied();
    const receipt = await confirmTechnicalDocumentAcquisition(prisma, session, { key,
      sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' }, ref, json(form, 'command'), String(form.get('token') ?? ''), form.get('confirmed') === 'on');
    revalidatePath(technicalUploadReviewPath(ref)); revalidatePath('/clients', 'layout');
    return { ok: true, recorded: true, message: `Acquisizione registrata: versione ${receipt.version}. Il file è privato; scegli separatamente chi può vederlo.` };
  } catch (error) { return error instanceof PrivilegedAdmissionRequired ? error.formState : failure(true); }
}
export async function checkTechnicalAcquisition(_state: TechnicalUploadState, form: FormData): Promise<TechnicalUploadState> {
  const session = await requireSession();
  try { await origin(); const result = await readTechnicalDocumentAcquisitionOutcome(prisma, session,
    technicalAssignmentReference.parse(json(form, 'reference')), String(form.get('commandId') ?? ''));
    return result.status === 'RECORDED' ? { ok: true, recorded: true, message: 'Acquisizione già registrata. Non ripeterla; la visibilità resta una scelta separata.' } : failure(true);
  } catch { return failure(true); }
}
