'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { PrivilegedAdmissionRequired, privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { restoreRemovedAccount } from './user-account-service';
import { withSerializableTransaction } from './serializable';
import { removeInternalUserWithAudit } from './user-privilege-service';
import { userIdSchema } from './validation';
import type { AccountFormState } from './user-account-contract';

export async function removeInternalAccount(_state: AccountFormState, form: FormData): Promise<AccountFormState> {
  const session = await requireSession();
  if (session.role !== 'admin') return { ok: false, message: 'Operazione riservata all’amministratore.' };
  const input = userIdSchema.safeParse(Object.fromEntries(form));
  if (!input.success || form.get('retainHistory') !== 'on') return { ok: false, message: 'Conferma la conservazione dello storico e delle attività.' };
  try {
    await requireEnforcedPrivilegedMutation(session, 'USER_ACCOUNT_UPDATE', { inline: true });
    const result = await withSerializableTransaction(prisma, tx => removeInternalUserWithAudit(tx, session, input.data.userId, true));
    if (!result.ok) return result;
    revalidatePath('/settings/users');
    revalidatePath(`/settings/users/${input.data.userId}`);
    revalidatePath('/settings/assignment-exceptions');
    return { ok: true, message: 'Account rimosso. Storico e attività conservati nella coda amministrativa.' };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) return error.formState;
    return { ok: false, message: 'Rimozione non completata. Riapri la scheda per verificare lo stato.' };
  }
}

export async function restoreInternalAccount(_state: AccountFormState, form: FormData): Promise<AccountFormState> {
  const session = await requireSession();
  if (session.role !== 'admin') return { ok: false, message: 'Operazione riservata all’amministratore.' };
  const input = userIdSchema.safeParse(Object.fromEntries(form));
  if (!input.success || form.get('restoreInactive') !== 'on') return { ok: false, message: 'Conferma il ripristino dell’identità con accesso ancora disattivato.' };
  try {
    await requireEnforcedPrivilegedMutation(session, 'USER_ACCOUNT_UPDATE', { inline: true });
    const key = await loadActivePrivilegedStepUpKey(prisma), store = await cookies();
    if (!key) return { ok: false, message: 'Conferma privilegiata non disponibile. Nessun ripristino eseguito.' };
    const result = await withSerializableTransaction(prisma, tx => restoreRemovedAccount(tx, session, input.data.userId, {
      key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' }));
    if (!result.ok) return result;
    for (const path of ['/settings/users', `/settings/users/${input.data.userId}`, '/settings/assignment-exceptions']) revalidatePath(path);
    return { ok: true, message: 'Identità ripristinata con lo stesso storico. L’accesso resta disattivato; rivedi ruolo e permessi prima di riattivarlo.' };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) return error.formState;
    return { ok: false, message: 'Ripristino non confermato. Riapri l’account per verificarne lo stato: non sarà creata una nuova identità.' };
  }
}
