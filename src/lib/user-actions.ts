'use server';
import { cookies, headers } from 'next/headers';
import { ZodError } from 'zod';
import { getSession } from './auth';
import { prisma } from './prisma';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { isAllowedMutationOrigin } from './application-security-policy';
import { PrivilegedAdmissionRequired, requireEnforcedPrivilegedMutation, privilegedStepUpCookieName } from './privileged-access';
import { adminUserCommandIdentity, adminUserOperation, type AdminUserCommandState } from './admin-user-command-contract';
import { AdminUserCommandError, executeAdminUserCommand, reconcileAdminUserCommand } from './admin-user-commands';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';

const codes = { CREATE: 'USER_CREATE', ACTIVATE: 'USER_ACTIVATE', DEACTIVATE: 'USER_DEACTIVATE', ROLE: 'USER_ROLE_UPDATE',
  OVERRIDES: 'USER_PERMISSION_OVERRIDE_UPDATE', RESET_OVERRIDES: 'USER_PERMISSION_OVERRIDE_RESET' } as const;
export async function submitAdminUserCommand(form: FormData): Promise<AdminUserCommandState> {
  const session = await getSession();
  if (!session || session.role !== 'admin') return { ok: false, message: 'Accedi con l’account Admin. Le scelte nel modulo sono conservate.' };
  try {
    const operation = adminUserOperation.parse(form.get('operation'));
    const identity = adminUserCommandIdentity.parse({ commandId: form.get('commandId'), userId: form.get('userId'), expectedVersion: form.get('expectedVersion'), operation });
    await requireEnforcedPrivilegedMutation(session, codes[operation], { inline: true });
    const key = await loadActivePrivilegedStepUpKey(prisma), store = await cookies();
    if (!key) return { ok: false, message: 'Conferma privilegiata non disponibile. Nessun comando eseguito.' };
    const values = operation === 'CREATE' ? { name: form.get('name'), email: form.get('email'), password: form.get('password'), role: form.get('role'), active: form.get('active') === 'on' }
      : operation === 'ROLE' ? { role: form.get('role') }
      : operation === 'OVERRIDES' ? { overrides: Array.from(form.entries()).filter(([name]) => name.startsWith('permission:')).map(([name, value]) => ({ permission: name.slice(11), value })) } : {};
    const receipt = await executeAdminUserCommand(prisma, session, identity, values, { key,
      sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '', stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' });
    // These authenticated pages read current data on every request. Keep the
    // current form and receipt URL stable until the explicit reopening link:
    // a server-action route refresh can discard the in-flight receipt fragment.
    return { ok: true, message: 'Operazione account registrata. Riapri la scheda per verificare lo stato corrente.', ...receipt };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) return error.formState;
    if (error instanceof ZodError) return { ok: false, message: 'Controlla i campi. La password iniziale richiede almeno 12 caratteri e al massimo 72 byte.' };
    if (error instanceof AdminUserCommandError) return { ok: false, closed: error.code === 'CLOSED', message: error.code === 'STALE'
      ? 'Lo stato dell’account è cambiato. Le scelte sono conservate: confronta la scheda aggiornata prima di preparare un nuovo comando.'
      : error.code === 'CLOSED' ? 'Questo tentativo è stato chiuso senza modifica. Riapri la scheda per una nuova operazione.'
        : 'Operazione non consentita: controlla ruolo, permessi e disponibilità dell’account.' };
    if (error instanceof RecordUpdateError) return { ok: false, stepUpRequired: true, message: 'La conferma è scaduta durante il controllo. Nessuna modifica applicata; le scelte sono conservate.' };
    if (error instanceof SerializableConflictError) return { ok: false, message: 'Un’operazione concorrente ha cambiato il contesto. Nessuna modifica applicata; riapri la scheda per confrontare i dati.' };
    return { ok: false, uncertain: true, message: 'Risposta non confermata. Verifica questo comando prima di ripetere qualsiasi operazione.' };
  }
}
export async function checkAdminUserCommand(input: unknown, close = false): Promise<AdminUserCommandState> {
  const session = await getSession(), h = await headers();
  if (!session || session.role !== 'admin' || !isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) return { ok: false, uncertain: true, message: 'Sessione o origine non disponibile. Nessuna operazione ripetuta.' };
  try {
    const receipt = await reconcileAdminUserCommand(prisma, session, input, close);
    return receipt ? { ok: !receipt.closed, ...receipt, message: receipt.closed ? 'Tentativo chiuso senza modifica dell’account.' : 'Operazione già registrata. Nessuna nuova esecuzione.' }
      : { ok: false, uncertain: true, message: 'Nessun esito registrato. Riconcilia e chiudi il tentativo prima di prepararne uno nuovo.' };
  } catch { return { ok: false, uncertain: true, message: 'Verifica non disponibile. Conserva il riferimento e riprova la verifica.' }; }
}
