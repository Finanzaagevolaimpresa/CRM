'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from './auth';
import { requireEnforcedPrivilegedMutation } from './privileged-access';
import { prisma } from './prisma';
import { withSerializableTransaction } from './serializable';
import { handoffInput, handoffPurchasedService } from './purchased-service-handoff';
import { UserFacingActionError } from './action-errors';

export async function purchasedServiceHandoffAction(_previous: { ok: boolean; message: string }, form: FormData) {
  const data = handoffInput.safeParse({ serviceId: form.get('serviceId'), expectedHash: form.get('expectedHash'),
    technicalOwnerId: form.get('technicalOwnerId'), departmentCode: form.get('departmentCode'), variantCode: form.get('variantCode'),
    dueDate: `${form.get('dueDate')}T12:00:00.000Z`, activities: String(form.get('activities') ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean),
    confirmed: form.get('confirmed') === 'on', reason: form.get('reason') });
  if (!data.success) return { ok: false, message: 'Compila referente, reparto, variante, scadenza, attività e conferma dei requisiti.' };
  const actor = await requirePermission('technical.assign');
  if (actor.role !== 'admin') return { ok: false, message: 'Solo l’amministratore dispone il passaggio.' };
  await requireEnforcedPrivilegedMutation(actor, 'R05_PURCHASED_SERVICE_HANDOFF');
  try {
    const result = await withSerializableTransaction(prisma, tx => handoffPurchasedService(tx, actor, data.data, true));
    revalidatePath(`/services/${data.data.serviceId}/handoff`); revalidatePath(`/clients/${result.receipt.clientId}`);
    revalidatePath(`/technical-office/practices/${result.receipt.technicalPracticeId}`); revalidatePath('/assignments');
    return { ok: true, message: 'Passaggio registrato. Il referente tecnico deve confermare la presa in carico.' };
  } catch (error) { return { ok: false, message: error instanceof UserFacingActionError ? error.message : 'Passaggio non completato. Riapri il riepilogo e verifica i dati.' }; }
}
