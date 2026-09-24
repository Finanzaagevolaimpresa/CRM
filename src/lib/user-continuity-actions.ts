'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { requireEnforcedPrivilegedMutation } from './privileged-access';
import { withSerializableTransaction } from './serializable';
import { removeInternalUserWithAudit } from './user-privilege-service';
import { userIdSchema } from './validation';
import type { AccountFormState } from './user-account-contract';

export async function removeInternalAccount(_state: AccountFormState, form: FormData): Promise<AccountFormState> {
  const session = await requireSession();
  if (session.role !== 'admin') return { ok: false, message: 'Operazione riservata all’amministratore.' };
  await requireEnforcedPrivilegedMutation(session, 'USER_ACCOUNT_UPDATE');
  const input = userIdSchema.safeParse(Object.fromEntries(form));
  if (!input.success || form.get('retainHistory') !== 'on') return { ok: false, message: 'Conferma la conservazione dello storico e delle attività.' };
  try {
    const result = await withSerializableTransaction(prisma, tx => removeInternalUserWithAudit(tx, session, input.data.userId, true));
    if (!result.ok) return result;
    revalidatePath('/settings/users');
    revalidatePath(`/settings/users/${input.data.userId}`);
    revalidatePath('/settings/assignment-exceptions');
    return { ok: true, message: 'Account rimosso. Storico e attività conservati nella coda amministrativa.' };
  } catch {
    return { ok: false, message: 'Rimozione non completata. Riapri la scheda per verificare lo stato.' };
  }
}
