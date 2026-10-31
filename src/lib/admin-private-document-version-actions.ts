'use server';
import { cookies, headers } from 'next/headers';
import { ZodError } from 'zod';
import { getSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, privilegedAccessReadiness } from './privileged-access';
import { saveAdminPrivateVersion, reconcileAdminPrivateVersion } from './admin-private-document-versions';
import { PrivateVersionError } from './private-document-versions';
import { PrivateDocumentMetadataError } from './private-document-metadata';
import { TechnicalAssignmentError } from './technical-assignment-transaction';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';
export type VersionResult = { ok: boolean; message: string; stepUp?: boolean; uncertain?: boolean; closed?: boolean };
async function actor() {
  const session = await getSession(), h = await headers();
  return session?.role === 'admin' && isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL }) ? session : null;
}
function failure(error: unknown): VersionResult {
  if (error instanceof RecordUpdateError) return { ok: false, stepUp: true, message: 'Riconferma l’identità. File, scelta e motivazione restano disponibili.' };
  if (error instanceof PrivateVersionError) return { ok: false, closed: error.code === 'CLOSED', message: {
    DENIED: 'L’autorità personale o i permessi correnti non consentono questa versione.',
    INVALID: 'Scegli un solo file ammesso, fino a 25 MB, oppure una versione esistente da riprendere.',
    STALE: 'Il documento è cambiato. Riapri e confronta le versioni prima di una nuova operazione.',
    CLOSED: 'Tentativo chiuso. Riapri la scheda per una nuova operazione.',
    INTEGRITY: 'La fonte, i byte o la cronologia richiedono verifica. Nessuna nuova versione ammessa.',
  }[error.code] };
  if (error instanceof TechnicalAssignmentError || error instanceof PrivateDocumentMetadataError) return { ok: false, message: 'Documento non disponibile con l’autorità e il contesto correnti.' };
  if (error instanceof SerializableConflictError) return { ok: false, message: 'Modifica concorrente: transazione annullata. Il file e le scelte sono conservati.' };
  if (error instanceof ZodError) return { ok: false, message: 'Controlla file, scelta, motivazione e conferma.' };
  return { ok: false, uncertain: true, message: 'Esito da verificare prima di caricare nuovamente il file.' };
}
export async function saveAdminPrivateVersionAction(form: FormData): Promise<VersionResult> {
  const session = await actor(); if (!session) return { ok: false, message: 'Sessione Admin o origine non ammessa.' };
  const readiness = await privilegedAccessReadiness(session);
  if (!readiness.active) return { ok: false, stepUp: readiness.mode === 'enforced' && readiness.keyReady, message: 'Riconferma l’identità qui sotto. Il file e la bozza restano disponibili.' };
  try {
    const key = await loadActivePrivilegedStepUpKey(prisma), jar = await cookies();
    if (!key) return { ok: false, message: 'Conferma privilegiata non disponibile.' };
    const file = form.get('file');
    await saveAdminPrivateVersion(prisma, session, { commandId: form.get('commandId'), id: form.get('id'), expectedVersion: form.get('expectedVersion'),
      restoreVersionId: form.get('restoreVersionId') || null, reason: form.get('reason'), confirmed: form.get('confirmed') === 'true' },
    file instanceof File && file.size ? file : null, { key, sessionToken: jar.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: jar.get(privilegedStepUpCookieName)?.value ?? '' });
    return { ok: true, message: 'Nuova versione privata registrata. Le versioni precedenti sono conservate e le vecchie selezioni invalidate. Scegli esplicitamente eventuali nuove concessioni.' };
  } catch (error) { return failure(error); }
}
export async function reconcileAdminPrivateVersionAction(raw: unknown): Promise<VersionResult> {
  const session = await actor(); if (!session) return { ok: false, uncertain: true, message: 'Accedi come Admin e verifica lo stesso tentativo.' };
  try {
    const result = await reconcileAdminPrivateVersion(prisma, session, raw);
    return result.status === 'RECORDED' ? { ok: true, message: 'Versione già registrata. Riapri per verificarla senza nuovo caricamento.' }
      : result.status === 'CLOSED' ? { ok: false, closed: true, message: 'Tentativo chiuso senza versione registrata. Il comando precedente non può arrivare in ritardo.' }
        : { ok: false, uncertain: true, message: 'Nessun esito osservato. Verifica ancora o chiudi il tentativo prima di ripartire.' };
  } catch (error) { return { ...failure(error), uncertain: true }; }
}
