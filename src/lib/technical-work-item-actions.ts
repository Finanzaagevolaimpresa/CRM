'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import type { TechnicalWorkItemState } from '@/components/technical-work-item-form';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { TechnicalAssignmentError } from './technical-assignment-transaction';
import { technicalTargetReference, technicalWorkPath } from './technical-assignment-display';
import { previewTechnicalWorkItem, confirmTechnicalWorkItem, readTechnicalWorkItemOutcome } from './technical-work-item-service';
import { SerializableConflictError } from './serializable';

function failure(error: unknown): TechnicalWorkItemState {
  if (error instanceof ZodError || error instanceof SyntaxError || error instanceof SerializableConflictError
    || (error instanceof TechnicalAssignmentError && error.code !== 'UNAVAILABLE')) {
    return { ok: false, message: 'La modifica non è stata registrata: attività, incarico o permessi non più validi. Ricarica prima di riprovare.' };
  }
  return { ok: false, uncertain: true, message: 'Esito non confermato. Verifica la ricevuta senza ripetere il salvataggio.' };
}
function json(form: FormData, name: string) {
  const raw = form.get(name);
  if (typeof raw !== 'string' || raw.length > 48_000) throw new TechnicalAssignmentError('DENIED');
  return JSON.parse(raw) as unknown;
}
async function origin() {
  const h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new TechnicalAssignmentError('DENIED');
}
export async function prepareTechnicalWorkItem(_state: TechnicalWorkItemState, form: FormData): Promise<TechnicalWorkItemState> {
  const session = await requireSession();
  try { await origin();
    const preview = await previewTechnicalWorkItem(prisma, session, technicalTargetReference.parse(json(form, 'target')), json(form, 'command'));
    return { ok: true, message: 'Controlla i soli campi che verranno modificati.', preview };
  } catch (error) { return failure(error); }
}
export async function saveTechnicalWorkItem(_state: TechnicalWorkItemState, form: FormData): Promise<TechnicalWorkItemState> {
  const session = await requireSession();
  try { await origin(); const target = technicalTargetReference.parse(json(form, 'target'));
    const receipt = await confirmTechnicalWorkItem(prisma, session, target, json(form, 'command'), String(form.get('token') ?? ''), form.get('confirmed') === 'on');
    revalidatePath(technicalWorkPath(target), 'layout');
    for (const path of ['/technical-work', '/dashboard', '/progress', '/notifications', '/search']) revalidatePath(path);
    return { ok: true, message: 'Modifica registrata con ricevuta. Nessun messaggio è stato inviato.', outcome: { status: 'RECORDED', receipt } };
  } catch (error) { return failure(error); }
}
export async function checkTechnicalWorkItem(_state: TechnicalWorkItemState, form: FormData): Promise<TechnicalWorkItemState> {
  const session = await requireSession();
  try { await origin();
    const outcome = await readTechnicalWorkItemOutcome(prisma, session, technicalTargetReference.parse(json(form, 'target')), String(form.get('commandId') ?? ''));
    return outcome.status === 'RECORDED' ? { ok: true, message: 'Modifica già registrata. Non ripetere il salvataggio.', outcome }
      : { ok: false, uncertain: true, message: 'Ricevuta non osservata: attendi la riconciliazione prima di un’altra modifica.', outcome };
  } catch (error) { return { ...failure(error), uncertain: true }; }
}
