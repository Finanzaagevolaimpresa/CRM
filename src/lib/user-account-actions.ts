'use server';

import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { withSerializableTransaction } from './serializable';
import { clearPrivilegedStepUpCookie, requireEnforcedPrivilegedMutation } from './privileged-access';
import { accountProfileSchema, passwordChangeSchema, passwordResetSchema, type AccountFormState } from './user-account-contract';
import { changeAccountPassword, resetAccountPassword, revokeAccountSessions, updateAccountProfile } from './user-account-service';
import { internalSessionMode } from './session';

type Operation = 'profile' | 'password' | 'reset' | 'revoke';

async function mutate(operation: Operation, form: FormData): Promise<AccountFormState> {
  const session = await requireSession();
  const userId = operation === 'password' ? session.userId : String(form.get('userId') ?? session.userId);
  const profile = operation === 'profile' ? accountProfileSchema.safeParse({ name: form.get('name'), email: form.get('email') }) : null;
  if (profile && !profile.success) return { ok: false, message: 'Controlla nome e indirizzo email.' };
  const profileData = profile?.success ? profile.data : undefined;
  let ownEmailChanged = false;
  if (profileData && userId === session.userId) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (!user) return { ok: false, message: 'Account non disponibile.' };
      ownEmailChanged = profileData.email !== user.email;
    } catch { return { ok: false, message: 'Profilo non disponibile. Riapri la pagina prima di riprovare.' }; }
  }
  const adminOperation = operation === 'reset' || userId !== session.userId || ownEmailChanged;
  let privilegedAdmission = false;
  if (adminOperation) {
    if (session.role !== 'admin') return { ok: false, message: 'Solo un amministratore può modificare l’email di accesso o altri account.' };
    await requireEnforcedPrivilegedMutation(session, 'USER_ACCOUNT_UPDATE');
    privilegedAdmission = true;
  }
  let result: AccountFormState & { sessionRevoked?: boolean };
  try {
    if (internalSessionMode() !== 'registry') return { ok: false, message: 'Gestione account non disponibile. Contatta un amministratore.' };
    if (operation === 'profile') {
      if (!profileData) return { ok: false, message: 'Controlla nome e indirizzo email.' };
      const outcome = await withSerializableTransaction(prisma, (tx) => updateAccountProfile(tx, session, userId, profileData, privilegedAdmission));
      result = outcome.ok ? { ...outcome, message: 'Profilo aggiornato.' } : outcome;
    } else if (operation === 'revoke') {
      const outcome = await withSerializableTransaction(prisma, (tx) => revokeAccountSessions(tx, session, userId));
      result = outcome.ok ? { ...outcome, message: 'Tutte le sessioni dell’account sono state revocate.' } : outcome;
    } else {
      const input = { currentPassword: form.get('currentPassword'), password: form.get('password'), confirmation: form.get('confirmation') };
      const data = operation === 'password' ? passwordChangeSchema.safeParse(input) : passwordResetSchema.safeParse(input);
      if (!data.success) return { ok: false, message: 'Usa una nuova password di almeno 12 caratteri (massimo 72 byte) e confermala.' };
      const outcome = operation === 'password'
        ? await withSerializableTransaction(prisma, (tx) => changeAccountPassword(tx, session, { currentPassword: String(input.currentPassword), password: data.data.password }))
        : await (async () => {
          const passwordHash = await bcrypt.hash(data.data.password, 12);
          return withSerializableTransaction(prisma, (tx) => resetAccountPassword(tx, session, userId, passwordHash));
        })();
      result = outcome.ok ? { ...outcome, message: 'Password aggiornata. Le sessioni precedenti sono state revocate.' } : outcome;
    }
  } catch {
    // Validation, uniqueness and transaction errors must not serialize submitted secrets.
    return { ok: false, message: 'Modifica non completata. Controlla i dati e riapri la pagina prima di riprovare.' };
  }
  if (result.ok) {
    revalidatePath('/settings/users');
    revalidatePath(`/settings/users/${userId}`);
    revalidatePath('/settings/account');
  }
  if (result.sessionRevoked) {
    (await cookies()).delete(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session');
    await clearPrivilegedStepUpCookie();
    redirect('/login?status=account-updated');
  }
  return { ok: result.ok, message: result.message };
}

export async function saveAccountProfile(_state: AccountFormState, form: FormData) { return mutate('profile', form); }
export async function saveOwnPassword(_state: AccountFormState, form: FormData) { return mutate('password', form); }
export async function adminResetPassword(_state: AccountFormState, form: FormData) { return mutate('reset', form); }
export async function revokeAllAccountSessions(_state: AccountFormState, form: FormData) { return mutate('revoke', form); }
