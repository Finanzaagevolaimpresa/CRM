'use server';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { requireEnforcedPrivilegedMutation } from './privileged-access';
import { withSerializableTransaction } from './serializable';
import { reassignExceptionTask } from './exception-task-assignment';

const input = z.object({ id: z.string().min(1).max(128), updatedAt: z.string().datetime(), assignedToId: z.string().min(1).max(128) });
type State = { ok: boolean; message: string };
export async function assignExceptionTask(_state: State, form: FormData): Promise<State> {
  const actor = await requirePermission('user.write');
  if (actor.role !== 'admin') return { ok: false, message: 'Operazione riservata all’amministratore.' };
  await requireEnforcedPrivilegedMutation(actor, 'R05_TASK_EXCEPTION_ASSIGN');
  const parsed = input.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, message: 'Dati non validi. Riapri l’attività.' };
  try {
    const row = await withSerializableTransaction(prisma, tx => reassignExceptionTask(tx, actor,
      { ...parsed.data, updatedAt: new Date(parsed.data.updatedAt) }, true));
    revalidatePath('/settings/assignment-exceptions');
    revalidatePath('/settings/assignment-exceptions/tasks/' + row.id);
    revalidatePath('/tasks'); revalidatePath('/dashboard');
    if (row.clientId) revalidatePath('/clients/' + row.clientId);
    return { ok: true, message: 'Attività riassegnata. Stato e storico conservati.' };
  } catch {
    return { ok: false, message: 'Riassegnazione non completata. Riapri l’attività e verifica utente e modifiche intervenute.' };
  }
}
