'use server';

import { redirect } from 'next/navigation';
import { requireAnyPermission, getSession, hasPermission } from './auth';
import { privilegedAccessPermissions } from './privileged-access-contract';
import { securityReturnPath } from './security-return-path';
import {
  clearPrivilegedStepUpCookie,
  establishPrivilegedStepUp,
  privilegedAccessReadiness,
} from './privileged-access';

export async function establishPrivilegedStepUpAction(formData: FormData) {
  const session = await requireAnyPermission([...privilegedAccessPermissions]);
  const password = String(formData.get('password') ?? '');
  const returnPath = securityReturnPath(formData.get('returnTo'));
  const returnQuery = returnPath ? '&returnTo=lead-inbox' : '';
  let result: 'DISABLED' | 'DENIED' | 'UNAVAILABLE' | 'ESTABLISHED' = 'UNAVAILABLE';
  try { result = await establishPrivilegedStepUp(session, password); } catch { result = 'UNAVAILABLE'; }
  if (result === 'ESTABLISHED') redirect(returnPath ?? '/settings/security?status=active');
  if (result === 'DISABLED') redirect(`/settings/security?status=disabled${returnQuery}`);
  if (result === 'DENIED') redirect(`/settings/security?status=denied${returnQuery}`);
  redirect(`/settings/security?status=unavailable${returnQuery}`);
}

/** No redirect: the open editor and its choices remain mounted. This confirms
 * identity only and never replays the operation that requested confirmation. */
export async function establishPrivilegedStepUpInline(_previous: { ok: boolean; message: string; expiresAt?: number }, form: FormData) {
  try {
    const session = await getSession();
    if (!session || !privilegedAccessPermissions.some(permission => hasPermission(session, permission)))
      return { ok: false, message: 'Sessione non disponibile. Accedi nuovamente prima di riprendere.' };
    const result = await establishPrivilegedStepUp(session, String(form.get('password') ?? ''));
    if (result !== 'ESTABLISHED') return { ok: false,
      message: result === 'DENIED' ? 'Conferma non riuscita. Verifica la password corrente.' : 'Conferma di sicurezza non disponibile.' };
    const readiness = await privilegedAccessReadiness(session);
    if (!readiness.active || !readiness.expiresAt) return { ok: false, message: 'Conferma non verificata. Nessuna operazione avviata.' };
    return { ok: true, expiresAt: readiness.expiresAt,
      message: `Identità confermata. La conferma dura ${session.role === 'admin' ? '30' : '5'} minuti. Le scelte sono conservate; scegli personalmente quando proseguire.` };
  } catch { return { ok: false, message: 'Conferma non verificata. Le scelte restano disponibili; nessuna operazione avviata.' }; }
}

export async function clearPrivilegedStepUpAction() {
  await requireAnyPermission([...privilegedAccessPermissions]);
  await clearPrivilegedStepUpCookie();
  redirect('/settings/security?status=cleared');
}
