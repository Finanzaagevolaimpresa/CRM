'use server';
import { cookies, headers } from 'next/headers';
import { ZodError } from 'zod';
import { getSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, privilegedAccessReadiness } from './privileged-access';
import { saveAdminRoleProfile, reconcileAdminRoleProfile } from './admin-role-profiles';
import { RoleProfileError } from './admin-role-profile-contract';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';
export type RoleProfileResult = { ok: boolean; message: string; stepUp?: boolean; uncertain?: boolean; closed?: boolean };
async function actor() {
  const session = await getSession(), h = await headers();
  return session?.role === 'admin' && isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL }) ? session : null;
}
function failure(error: unknown): RoleProfileResult {
  if (error instanceof RecordUpdateError) return { ok: false, stepUp: true, message: 'Riconferma l’identità. Le scelte del profilo sono conservate.' };
  if (error instanceof RoleProfileError) return { ok: false, closed: error.code === 'CLOSED', message: {
    DENIED: 'Il profilo richiede i permessi Admin correnti.',
    INVALID: 'Controlla i permessi selezionati; quelli protetti non sono modificabili.',
    STALE: 'Il profilo è cambiato. Confronta la versione corrente con le scelte conservate.',
    CLOSED: 'Tentativo chiuso. Apri una nuova operazione.',
    INTEGRITY: 'La cronologia del profilo richiede verifica. Nessun permesso applicato.',
  }[error.code] };
  if (error instanceof SerializableConflictError) return { ok: false, message: 'Modifica concorrente: nessun effetto registrato. Le scelte sono conservate.' };
  if (error instanceof ZodError) return { ok: false, message: 'Controlla ruolo, permessi, motivazione e conferma.' };
  return { ok: false, uncertain: true, message: 'Esito da verificare prima di un’altra operazione.' };
}
export async function saveAdminRoleProfileAction(raw: unknown): Promise<RoleProfileResult> {
  const session = await actor(); if (!session) return { ok: false, message: 'Sessione Admin o origine non ammessa.' };
  const readiness = await privilegedAccessReadiness(session);
  if (!readiness.active) return { ok: false, stepUp: readiness.mode === 'enforced' && readiness.keyReady, message: 'Riconferma l’identità qui sotto. Le scelte restano disponibili.' };
  try {
    const key = await loadActivePrivilegedStepUpKey(prisma), jar = await cookies();
    if (!key) return { ok: false, message: 'Conferma privilegiata non disponibile.' };
    await saveAdminRoleProfile(prisma, session, raw, { key,
      sessionToken: jar.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: jar.get(privilegedStepUpCookieName)?.value ?? '' });
    return { ok: true, message: 'Profilo registrato per i nuovi account. Gli account esistenti restano invariati; applica il profilo dalla loro scheda quando necessario.' };
  } catch (error) { return failure(error); }
}
export async function reconcileAdminRoleProfileAction(raw: unknown): Promise<RoleProfileResult> {
  const session = await actor();
  if (!session) return { ok: false, uncertain: true, message: 'Accedi come Admin e verifica lo stesso tentativo.' };
  try {
    const result = await reconcileAdminRoleProfile(prisma, session, raw);
    return result.status === 'RECORDED' ? { ok: true, message: 'Profilo già registrato. Riapri la versione corrente.' }
      : result.status === 'CLOSED' ? { ok: false, closed: true, message: 'Tentativo chiuso senza modifica. Il vecchio comando non può arrivare in ritardo.' }
        : { ok: false, uncertain: true, message: 'Nessun esito osservato: verifica ancora o chiudi il tentativo prima di ripartire.' };
  } catch (error) { return { ...failure(error), uncertain: true }; }
}
