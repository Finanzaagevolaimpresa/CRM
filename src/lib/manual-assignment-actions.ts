'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { withAssignmentGuard } from './manual-assignment-guard';

type State = { ok: boolean; message: string };
const input = z.object({
  id: z.string().min(1).max(128),
  updatedAt: z.string().datetime(),
  commercialOwnerId: z.string().max(128),
  technicalOwnerId: z.string().max(128),
});

async function save(kind: 'client' | 'project', form: FormData): Promise<State> {
  const session = await requireSession();
  if (session.role !== 'admin') return { ok: false, message: 'Solo l’amministratore può cambiare i responsabili.' };
  const parsed = input.safeParse(Object.fromEntries(form.entries()));
  if (!parsed.success) return { ok: false, message: 'Dati non validi. Riapri la scheda.' };
  const data = parsed.data;
  const commercial = kind === 'client' ? data.commercialOwnerId || null : null;
  const technical = data.technicalOwnerId || null;
  try {
    await withAssignmentGuard(prisma, session, true, [
      { userId: commercial, roles: ['admin', 'direzione', 'commerciale'] },
      { userId: technical, roles: ['admin', 'direzione', 'consulente', 'backoffice'] },
    ], async tx => {
      const where = { id: data.id, updatedAt: new Date(data.updatedAt), deletedAt: null };
      if (kind === 'client') {
        const before = await tx.client.findFirstOrThrow({ where });
        const after = await tx.client.update({ where, data: { salesOwnerId: commercial, consultantId: technical } });
        await tx.auditLog.create({ data: {
          actorId: session.userId, event: 'client_owners_assigned', entityType: 'Client', entityId: after.id,
          before: { salesOwnerId: before.salesOwnerId, consultantId: before.consultantId },
          after: { salesOwnerId: after.salesOwnerId, consultantId: after.consultantId },
        } });
      } else {
        const before = await tx.project.findFirstOrThrow({ where });
        const after = await tx.project.update({ where, data: { consultantId: technical } });
        await tx.auditLog.create({ data: {
          actorId: session.userId, event: 'project_owner_assigned', entityType: 'Project', entityId: after.id,
          before: { consultantId: before.consultantId }, after: { consultantId: after.consultantId },
        } });
      }
    });
  } catch {
    return { ok: false, message: 'Assegnazione non completata. Riapri la scheda e verifica utenti e modifiche intervenute.' };
  }
  revalidatePath('/clients'); revalidatePath('/projects'); revalidatePath('/dashboard');
  revalidatePath('/clients/' + data.id); revalidatePath('/projects/' + data.id);
  return { ok: true, message: 'Responsabili aggiornati.' };
}
export async function assignClientOwners(_previous: State, form: FormData) { return save('client', form); }
export async function assignProjectOwner(_previous: State, form: FormData) { return save('project', form); }
