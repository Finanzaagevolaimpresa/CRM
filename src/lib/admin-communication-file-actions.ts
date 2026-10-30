'use server';
import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { getSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, privilegedAccessReadiness } from './privileged-access';
import { replaceAdminCommunicationFile, searchAdminCommunicationFileContexts, AdminCommunicationFileError } from './admin-communication-files';
import { ApprovedCommunicationError } from './approved-communication-contract';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';
import type { AdminSaveResult } from './admin-record-actions';

export async function searchAdminCommunicationFileContextsAction(raw: unknown) {
  const session = await getSession();
  if (!session || session.role !== 'admin') return { ok: false as const };
  try { return { ok: true as const, value: await searchAdminCommunicationFileContexts(prisma, session, raw) }; }
  catch { return { ok: false as const }; }
}
export async function replaceAdminCommunicationFileAction(form: FormData): Promise<AdminSaveResult> {
  const session = await getSession(), h = await headers();
  if (!session || session.role !== 'admin' || !isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) return { ok: false, message: 'Sessione Admin o origine non ammessa. La bozza è conservata.' };
  const readiness = await privilegedAccessReadiness(session);
  if (!readiness.active) return { ok: false, stepUp: readiness.mode === 'enforced' && readiness.keyReady,
    message: 'Riconferma l’identità qui sotto, poi registra la versione. File e scelte restano in questo modulo.' };
  try {
    const key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) return { ok: false, message: 'Conferma privilegiata non disponibile.' };
    const raw = form.get('command');
    if (typeof raw !== 'string' || raw.length > 20_000) return { ok: false, message: 'Comando non valido.' };
    const value = form.get('file');
    if (value !== null && !(value instanceof File)) return { ok: false, message: 'File non valido.' };
    const jar = await cookies();
    const receipt = await replaceAdminCommunicationFile(prisma, session, JSON.parse(raw), value, { key,
      sessionToken: jar.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: jar.get(privilegedStepUpCookieName)?.value ?? '' });
    revalidatePath('/communications'); revalidatePath('/admin/records/CommunicationContextFile'); revalidatePath('/admin/communication-files');
    return { ok: true, receipt, message: 'Nuova versione registrata. Per usarla in una comunicazione selezionala esplicitamente nella bozza.' };
  } catch (error) {
    if (error instanceof RecordUpdateError) return { ok: false, stepUp: true, message: 'Conferma o autorizzazione scaduta. File e scelte restano disponibili; riconferma prima di proseguire.' };
    if (error instanceof AdminCommunicationFileError) return { ok: false, message: {
      DENIED: 'Permessi o contesto correnti non consentono questa operazione.',
      INVALID: 'Controlla nome, file, operazione e motivazione.',
      STALE: 'La fonte o il comando sono cambiati. Confronta la fonte attuale con questa bozza conservata.',
      CLOSED: 'Questo tentativo è chiuso. Apri una nuova operazione per proseguire.',
      QUOTA: 'Il contesto ha raggiunto il limite di file o spazio. I file revocati continuano a occupare spazio.',
    }[error.code] };
    if (error instanceof ApprovedCommunicationError) return { ok: false, message: 'La disponibilità del contesto o l’autorità sulle comunicazioni è cambiata. La bozza è conservata.' };
    if (error instanceof ZodError || error instanceof SyntaxError) return { ok: false, message: 'Controlla i dati e la conferma della nuova versione.' };
    if (error instanceof SerializableConflictError) return { ok: false, message: 'Operazione annullata per una modifica concorrente. La bozza è conservata.' };
    return { ok: false, uncertain: true, message: 'Esito da verificare prima di ripetere. Il riferimento del comando è conservato.' };
  }
}
