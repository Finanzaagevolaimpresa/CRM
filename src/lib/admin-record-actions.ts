'use server';
import { cookies, headers } from 'next/headers';
import { prepareAdminCatalogPublication } from './admin-records';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
export async function prepareAdminCatalogPublicationAction(id: string) {
  const session = await getSession();
  if (!session) return { ok: false as const };
  try { return { ok: true as const, value: await prepareAdminCatalogPublication(prisma, session, id) }; }
  catch { return { ok: false as const }; }
}
import { getSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, privilegedAccessReadiness } from './privileged-access';
import { saveAdminRecord, readAdminRecordReceipt, closeAdminRecordAttempt, searchAdminRecordReferences, AdminRecordError } from './admin-records';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';

export type AdminSaveResult = { ok: boolean; message: string; stepUp?: boolean; uncertain?: boolean; closed?: boolean;
  receipt?: { commandId: string; model: string; id: string; replayed: boolean; closed?: boolean } };
export async function searchAdminRecordReferencesAction(input: unknown) {
  const session = await getSession();
  if (!session || session.role !== 'admin') return { error: 'Sessione Admin non disponibile.' } as const;
  try { return await searchAdminRecordReferences(prisma, session, input); }
  catch { return { error: 'Ricerca non disponibile per questi permessi o parametri. La selezione è conservata.' } as const; }
}
export async function saveAdminRecordAction(raw: unknown): Promise<AdminSaveResult> {
  const session = await getSession();
  if (!session || session.role !== 'admin') return { ok: false, message: 'Sessione Admin non disponibile. I dati nel modulo sono conservati.' };
  const requestHeaders = await headers();
  if (!isAllowedMutationOrigin({ origin: requestHeaders.get('origin'), secFetchSite: requestHeaders.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) return { ok: false, message: 'Origine del salvataggio non ammessa.' };
  const readiness = await privilegedAccessReadiness(session);
  if (!readiness.active) return { ok: false, stepUp: readiness.mode === 'enforced' && readiness.keyReady,
    message: 'Riconferma la tua identità qui sotto. I dati e le scelte sono conservati; poi scegli Salva.' };
  try {
    const key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) throw new AdminRecordError('DENIED');
    const store = await cookies();
    const receipt = await saveAdminRecord(prisma, session, raw, { key,
      sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' });
    revalidatePath('/admin/records');
    return { ok: true, message: 'Operazione registrata. Puoi riaprire la scheda per verificare i dati salvati.', receipt };
  } catch (error) {
    if (error instanceof ZodError) return { ok: false, message: 'Controlla i campi, gli importi, le date e la motivazione. La bozza è conservata.' };
    if (error instanceof AdminRecordError) return { ok: false, message: {
      INVALID: 'Valori non validi: controlla i campi obbligatori, i collegamenti e la somma degli importi.',
      DENIED: 'La sessione o i permessi correnti non consentono questa operazione.',
      STALE: 'La scheda è cambiata. Aprila in una nuova scheda per confrontarla con questa bozza, che rimane disponibile.',
      HISTORY: 'Questo dato è già una prova o dipende da un ciclo dedicato. Usa il percorso indicato oppure registra una rettifica motivata senza riscrivere la prova.',
      DEPENDENCIES: 'Il cambio del collegamento sposterebbe una scheda con dipendenze. Occorre riallineare esplicitamente i record collegati: nessun dato è stato spostato.',
      CONTEXT: 'I collegamenti selezionati non appartengono allo stesso contesto oppure un record collegato non è operativo.',
      CLOSED: 'Questo tentativo è stato chiuso senza modifiche. Riapri la scheda per preparare una nuova operazione.',
      ACTIVE_NOTICE: 'Esiste già una versione attiva dello stesso codice e finalità. Ritirala dall’elenco delle informative, poi attiva questa versione verificata.',
    }[error.code] };
    if (error instanceof RecordUpdateError) return { ok: false, stepUp: true, message: 'Conferma o autorizzazione scaduta durante il salvataggio. Nessuna correzione è stata applicata; la bozza è conservata.' };
    if (error instanceof SerializableConflictError) return { ok: false, message: 'Un’altra operazione ha modificato lo stesso contesto. La correzione è stata annullata; confronta la scheda aggiornata con la bozza.' };
    return { ok: false, uncertain: true, message: 'La risposta non consente di attestare l’esito. Verifica il comando conservato prima di proseguire.' };
  }
}
export async function verifyAdminRecordAction(commandId: string): Promise<AdminSaveResult> {
  const session = await getSession();
  if (!session || session.role !== 'admin') return { ok: false, uncertain: true, message: 'Accedi nuovamente come Admin per verificare questo esito.' };
  try {
    const receipt = await readAdminRecordReceipt(prisma, session, commandId);
    return receipt?.closed ? { ok: false, closed: true, receipt, message: 'Tentativo chiuso senza modifica operativa. Puoi riaprire la scheda.' }
      : receipt ? { ok: true, receipt, message: 'Operazione già registrata. Nessun nuovo salvataggio eseguito.' }
      : { ok: false, uncertain: true, message: 'Esito non ancora registrato. Puoi riprendere lo stesso comando: la sua identità impedisce una doppia applicazione.' };
  } catch { return { ok: false, uncertain: true, message: 'Verifica temporaneamente non disponibile. Conserva questo modulo e riprova la verifica.' }; }
}

export async function closeAdminRecordAction(input: { commandId: string; model: string; id: string }): Promise<AdminSaveResult> {
  const session = await getSession(), h = await headers();
  if (!session || session.role !== 'admin' || !isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) return { ok: false, uncertain: true, message: 'Sessione o origine non ammessa.' };
  try {
    const receipt = await closeAdminRecordAttempt(prisma, session, input);
    return { ok: !receipt.closed, closed: receipt.closed, receipt,
      message: receipt.closed ? 'Tentativo riconciliato e chiuso senza modifica operativa.' : 'Operazione già registrata. Nessun nuovo salvataggio eseguito.' };
  } catch { return { ok: false, uncertain: true, message: 'Riconciliazione non disponibile. Conserva il riferimento e riprova la verifica.' }; }
}
