'use server';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { assertTechnicalServerAction } from './technical-server-guards';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { PrivilegedAdmissionRequired, privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { saveSharedOperationalUpdate, settleSharedOperationalReceipt } from './shared-operational-updates';
import { SharedOperationalUpdateError } from './shared-operational-update-contract';
import { TechnicalAssignmentError } from './technical-assignment-errors';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';

export async function saveSharedOperationalAction(raw: unknown) {
  await assertTechnicalServerAction('shared-operational-actions:saveSharedOperationalAction');
  const session = await requireSession();
  try {
    let proof;
    if (session.role === 'admin') {
      await requireEnforcedPrivilegedMutation(session, 'RECORD_UPDATE_MANAGE', { inline: true });
      const key = await loadActivePrivilegedStepUpKey(prisma);
      if (!key) throw new SharedOperationalUpdateError('DENIED');
      const store = await cookies();
      proof = { key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
        stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' };
    }
    const result = await saveSharedOperationalUpdate(prisma, session, raw, proof);
    revalidatePath('/notifications'); revalidatePath('/notifications/updates');
    return { ok: true as const, result };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) return error.formState;
    const known = error instanceof ZodError || error instanceof SharedOperationalUpdateError
      || error instanceof TechnicalAssignmentError || error instanceof RecordUpdateError || error instanceof SerializableConflictError;
    const stale = error instanceof SerializableConflictError || (error instanceof SharedOperationalUpdateError && error.code === 'STALE');
    return { ok: false as const, stepUpRequired: false, uncertain: !known,
      message: error instanceof ZodError ? 'Controlla il testo, lo stato scelto e la data della prossima azione.'
        : stale ? 'La scheda o l’incarico è cambiato. Il testo è conservato: rileggi i dati correnti prima di salvare.'
          : known ? 'Aggiornamento non disponibile nel tuo incarico corrente. Verifica assegnazione, autorizzazioni e destinatari con l’Admin.'
            : 'Esito non ancora osservato. Verifica la stessa richiesta prima di ripetere il salvataggio.' };
  }
}
export async function settleSharedOperationalAction(raw: unknown) {
  await assertTechnicalServerAction('shared-operational-actions:settleSharedOperationalAction');
  const session = await requireSession();
  try { return { ok: true as const, result: await settleSharedOperationalReceipt(prisma, session, raw) }; }
  catch { return { ok: false as const, message: 'Verifica non disponibile. Conserva il riferimento; non ripetere il salvataggio.' }; }
}
