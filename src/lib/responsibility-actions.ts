'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { requireEnforcedPrivilegedMutation } from './privileged-access';
import { withSerializableTransaction } from './serializable';
import { responsibilityKind } from './responsibility-contract';
import { acceptResponsibility, confirmLeadResponsibility, savePracticeResponsibility } from './responsibility';
import { UserFacingActionError } from './action-errors';

const optionalId = z.string().trim().max(128).transform(value => value || null);
const common = { kind: responsibilityKind, id: z.string().min(1).max(128) };
const assignmentSchema = z.object({ ...common, expectedEntryId: z.string().max(128), expectedUpdatedAt: z.string().datetime(),
  commercialOwnerId: optionalId, technicalOwnerId: optionalId, departmentCode: z.string().trim().max(80).transform(value => value || null),
  reason: z.string().trim().min(10).max(500) });
const acceptanceSchema = z.object({ ...common, decisionId: z.string().min(1).max(128), role: z.enum(['commerciale', 'tecnico']) });
type Result = { ok: boolean; message: string };
const failure = (error: unknown): Result => ({ ok: false, message: error instanceof UserFacingActionError ? error.message : 'Operazione non completata. Riapri la scheda e verifica le modifiche intervenute.' });
function refresh(kind: 'Lead' | 'TechnicalPractice', id: string) {
  revalidatePath(`/assignments/${kind}/${id}`); revalidatePath('/assignments');
  revalidatePath(kind === 'Lead' ? `/leads/${id}` : `/technical-office/practices/${id}`);
}
export async function saveResponsibilityAction(_previous: Result, form: FormData): Promise<Result> {
  const data = assignmentSchema.safeParse(Object.fromEntries(form.entries()));
  if (!data.success) return { ok: false, message: 'Compila i dati richiesti e la motivazione.' };
  const actor = await requirePermission(data.data.kind === 'Lead' ? 'lead.write' : 'technical.assign');
  if (actor.role !== 'admin') return { ok: false, message: 'Solo l’amministratore decide le assegnazioni.' };
  await requireEnforcedPrivilegedMutation(actor, 'R05_RESPONSIBILITY');
  try {
    await withSerializableTransaction(prisma, tx => data.data.kind === 'Lead'
      ? confirmLeadResponsibility(tx, actor, data.data, true) : savePracticeResponsibility(tx, actor, data.data, true));
  } catch (error) { return failure(error); }
  refresh(data.data.kind, data.data.id);
  return { ok: true, message: 'Decisione registrata. La presa in carico spetta al referente individuale.' };
}
export async function acceptResponsibilityAction(_previous: Result, form: FormData): Promise<Result> {
  const data = acceptanceSchema.safeParse(Object.fromEntries(form.entries()));
  if (!data.success) return { ok: false, message: 'Presa in carico non valida. Riapri la scheda.' };
  const actor = await requirePermission('assignment.accept');
  try { await withSerializableTransaction(prisma, tx => acceptResponsibility(tx, actor, data.data)); }
  catch (error) { return failure(error); }
  refresh(data.data.kind, data.data.id);
  return { ok: true, message: 'Presa in carico personale registrata.' };
}
