'use server';
import { cookies, headers } from 'next/headers';
import { ZodError } from 'zod';
import { getSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, privilegedAccessReadiness } from './privileged-access';
import { previewAdminOperationalLink, searchAdminOperationalLink, saveAdminOperationalLink, reconcileAdminOperationalLink } from './admin-operational-links';
import { OperationalLinkError } from './admin-operational-link-contract';
import { AdminRecordError } from './admin-records';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';
export type LinkResult = { ok: boolean; message: string; stepUp?: boolean; uncertain?: boolean; closed?: boolean };
async function actor() {
  const session = await getSession(), h = await headers();
  return session?.role === 'admin' && isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL }) ? session : null;
}
function failure(error: unknown): LinkResult {
  if (error instanceof RecordUpdateError) return { ok: false, stepUp: true, message: 'Riconferma l’identità. Le scelte e l’anteprima restano conservate.' };
  if (error instanceof OperationalLinkError) return { ok: false, closed: error.code === 'CLOSED', message: {
    DENIED: 'Permessi Admin o contesto non consentono questa rettifica.',
    INVALID: 'Scegli collegamenti diversi da quelli correnti e verifica i campi obbligatori.',
    STALE: 'Le schede sono cambiate. Prepara una nuova anteprima e confrontala prima della conferma.',
    CONTEXT: 'I collegamenti non appartengono allo stesso contesto operativo o una scheda non è disponibile.',
    CLOSED: 'Tentativo chiuso. Riapri la scheda per una nuova operazione.',
    FORMALIZED: 'Il servizio è collegato a un incarico formalizzato: correggi prima il suo contesto firmato dalla pratica.',
    PAYMENT: 'Il pagamento scelto deve appartenere al cliente e al contratto selezionati.',
  }[error.code] };
  if (error instanceof AdminRecordError) return { ok: false, message: 'Una scheda coinvolta non è accessibile nel contesto corrente.' };
  if (error instanceof SerializableConflictError) return { ok: false, message: 'Modifica concorrente: transazione annullata. Prepara una nuova anteprima con la bozza conservata.' };
  if (error instanceof ZodError) return { ok: false, message: 'Controlla collegamenti, motivazione e conferma.' };
  return { ok: false, uncertain: true, message: 'Esito da verificare prima di ripetere qualsiasi operazione.' };
}
export async function previewAdminOperationalLinkAction(raw: unknown) {
  const session = await actor(); if (!session) return { error: 'Sessione Admin o origine non ammessa.' };
  try { return await previewAdminOperationalLink(prisma, session, raw); } catch (error) { return { error: failure(error).message }; }
}
export async function searchAdminOperationalLinkAction(raw: unknown) {
  const session = await actor(); if (!session) return { error: 'Sessione Admin o origine non ammessa.' };
  try { return await searchAdminOperationalLink(prisma, session, raw); } catch (error) { return { error: failure(error).message }; }
}
export async function saveAdminOperationalLinkAction(raw: unknown): Promise<LinkResult> {
  const session = await actor(); if (!session) return { ok: false, message: 'Sessione Admin o origine non ammessa.' };
  const readiness = await privilegedAccessReadiness(session);
  if (!readiness.active) return { ok: false, stepUp: readiness.mode === 'enforced' && readiness.keyReady, message: 'Riconferma l’identità qui sotto. La bozza resta disponibile.' };
  try {
    const key = await loadActivePrivilegedStepUpKey(prisma), jar = await cookies();
    if (!key) return { ok: false, message: 'Conferma privilegiata non disponibile.' };
    await saveAdminOperationalLink(prisma, session, raw, { key, sessionToken: jar.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: jar.get(privilegedStepUpCookieName)?.value ?? '' });
    return { ok: true, message: 'Collegamenti corretti e registrati. Riapri le schede per verificarli; le prove storiche restano conservate.' };
  } catch (error) { return failure(error); }
}
export async function reconcileAdminOperationalLinkAction(raw: unknown): Promise<LinkResult> {
  const session = await actor(); if (!session) return { ok: false, uncertain: true, message: 'Accedi come Admin e verifica lo stesso tentativo.' };
  try {
    const value = await reconcileAdminOperationalLink(prisma, session, raw);
    return value.status === 'RECORDED' ? { ok: true, message: 'Rettifica già registrata. Riapri le schede per verificarla.' }
      : value.status === 'CLOSED' ? { ok: false, closed: true, message: 'Tentativo chiuso senza rettifica. Il comando precedente non può arrivare in ritardo.' }
        : { ok: false, uncertain: true, message: 'Nessun esito osservato. Verifica ancora o chiudi il tentativo prima di ripartire.' };
  } catch (error) { return { ...failure(error), uncertain: true }; }
}
