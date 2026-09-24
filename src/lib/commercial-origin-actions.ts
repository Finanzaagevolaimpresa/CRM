'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { requireEnforcedPrivilegedMutation } from './privileged-access';
import { withSerializableTransaction } from './serializable';
import { recordCommercialOrigin } from './commercial-origin';
import { UserFacingActionError } from './action-errors';

export async function saveCommercialOrigin(_previous: { ok: boolean; message: string }, form: FormData) {
  const actor = await requirePermission('client.write');
  if (actor.role !== 'admin') return { ok: false, message: 'La provenienza può essere registrata o rettificata soltanto dall’amministratore.' };
  await requireEnforcedPrivilegedMutation(actor, 'R05_COMMERCIAL_ORIGIN');
  const fields = ['clientId', 'expectedEntryId', 'acquiredById', 'contractedById', 'sourceReference', 'reason'];
  const raw = Object.fromEntries(fields.map(field => [field, form.get(field)]));
  try {
    await withSerializableTransaction(prisma, tx => recordCommercialOrigin(tx, actor, raw, true));
  } catch (error) {
    return { ok: false, message: error instanceof UserFacingActionError ? error.message : 'Registrazione non completata. Riapri la scheda e verifica le modifiche intervenute.' };
  }
  revalidatePath(`/clients/${String(raw.clientId)}/commercial-origin`);
  revalidatePath(`/clients/${String(raw.clientId)}`);
  return { ok: true, message: 'Provenienza registrata. Le versioni precedenti restano nello storico.' };
}
