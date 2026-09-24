'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { requireEnforcedPrivilegedMutation } from './privileged-access';
import { withSerializableTransaction } from './serializable';
import { changeClientReadGrant } from './client-read-perimeter';
import { UserFacingActionError } from './action-errors';

const schema = z.object({
  userId: z.string().min(1).max(128), clientId: z.string().min(1).max(128),
  expectedVersion: z.coerce.number().int().min(0).max(2_147_483_646), active: z.enum(['true', 'false']),
});
export async function updateClientReadPerimeter(_previous: { ok: boolean; message: string }, form: FormData) {
  const session = await requirePermission('user.write');
  if (session.role !== 'admin') return { ok: false, message: 'Solo l’amministratore può cambiare i perimetri.' };
  await requireEnforcedPrivilegedMutation(session, 'R05_CLIENT_READ_PERIMETER');
  const parsed = schema.safeParse(Object.fromEntries(form.entries()));
  if (!parsed.success) return { ok: false, message: 'Dati non validi. Aggiorna la pagina.' };
  try {
    await withSerializableTransaction(prisma, tx => changeClientReadGrant(tx, session, {
      ...parsed.data, active: parsed.data.active === 'true',
    }, true));
  } catch (error) {
    return { ok: false, message: error instanceof UserFacingActionError ? error.message : 'Perimetro non aggiornato. Riapri la scheda e verifica le modifiche intervenute.' };
  }
  revalidatePath(`/settings/users/${parsed.data.userId}/perimeter`);
  return { ok: true, message: parsed.data.active === 'true' ? 'Consultazione consentita.' : 'Consultazione revocata.' };
}
