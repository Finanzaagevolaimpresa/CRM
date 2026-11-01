'use server';
import { assertTechnicalServerAction } from './technical-server-guards';
import { cookies, headers } from 'next/headers';
import { getSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, privilegedAccessReadiness } from './privileged-access';
import { saveAdminTechnicalDisclosure, reconcileAdminTechnicalDisclosure, TechnicalDisclosureError } from './admin-technical-disclosure';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';
import { ZodError } from 'zod';
export type TechnicalDisclosureResult = { ok: boolean; message: string; stepUp?: boolean; uncertain?: boolean; closed?: boolean };
async function actor() {
  const session = await getSession(), h = await headers();
  return session?.role === 'admin' && isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL }) ? session : null;
}
function failure(error: unknown): TechnicalDisclosureResult {
  if (error instanceof RecordUpdateError) return { ok: false, stepUp: true, message: 'Riconferma l’identità. Classificazione e motivazione sono conservate.' };
  if (error instanceof TechnicalDisclosureError) return { ok: false, closed: error.code === 'CLOSED', message: {
    DENIED: 'Versione o classificazione non disponibile. Un contenuto riservato non può diventare tecnico tramite questa scelta.',
    STALE: 'La versione o la classificazione è cambiata. Riapri e confronta il dato corrente.',
    CLOSED: 'Tentativo chiuso senza nuova classificazione.', INVALID: 'Controlla classificazione e dichiarazioni.',
  }[error.code] };
  if (error instanceof SerializableConflictError) return { ok: false, message: 'Modifica concorrente: nessuna classificazione registrata.' };
  if (error instanceof ZodError) return { ok: false, message: 'Completa motivazione, verifica della versione e conferma.' };
  return { ok: false, uncertain: true, message: 'Esito da verificare sullo stesso tentativo.' };
}
export async function saveTechnicalDisclosureAction(raw: unknown): Promise<TechnicalDisclosureResult> {
  await assertTechnicalServerAction("admin-technical-disclosure-actions:saveTechnicalDisclosureAction");
  const session = await actor(); if (!session) return { ok: false, message: 'Sessione Admin o origine non ammessa.' };
  const readiness = await privilegedAccessReadiness(session);
  if (!readiness.active) return { ok: false, stepUp: readiness.mode === 'enforced' && readiness.keyReady,
    message: 'Riconferma l’identità qui sotto; le scelte restano disponibili.' };
  try {
    const key = await loadActivePrivilegedStepUpKey(prisma), jar = await cookies();
    if (!key) return { ok: false, message: 'Conferma privilegiata non disponibile.' };
    await saveAdminTechnicalDisclosure(prisma, session, raw, { key,
      sessionToken: jar.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: jar.get(privilegedStepUpCookieName)?.value ?? '' });
    return { ok: true, message: 'Classificazione della versione registrata. Nessun destinatario o grant aggiunto.' };
  } catch (error) { return failure(error); }
}
export async function reconcileTechnicalDisclosureAction(raw: unknown): Promise<TechnicalDisclosureResult> {
  await assertTechnicalServerAction("admin-technical-disclosure-actions:reconcileTechnicalDisclosureAction");
  const session = await actor();
  if (!session) return { ok: false, uncertain: true, message: 'Accedi come Admin e verifica lo stesso tentativo.' };
  try {
    const result = await reconcileAdminTechnicalDisclosure(prisma, session, raw);
    return result.status === 'RECORDED' ? { ok: true, message: 'Classificazione già registrata. Riapri la versione corrente.' }
      : result.status === 'CLOSED' ? { ok: false, closed: true, message: 'Tentativo chiuso; il vecchio comando non potrà essere applicato.' }
        : { ok: false, uncertain: true, message: 'Nessun esito osservato. Verifica ancora o chiudi esplicitamente il tentativo.' };
  } catch (error) { return { ...failure(error), uncertain: true }; }
}
