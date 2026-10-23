'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import type { TechnicalWorkState } from '@/components/technical-work-form';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { TechnicalAssignmentError } from './technical-assignment-transaction';
import { technicalTargetReference, technicalWorkPath } from './technical-assignment-display';
import { previewTechnicalWork, confirmTechnicalWork, readTechnicalWorkOutcome } from './technical-work-service';
import { SerializableConflictError } from './serializable';

function failure(error: unknown): TechnicalWorkState {
  if (error instanceof ZodError || error instanceof SyntaxError || error instanceof SerializableConflictError
    || (error instanceof TechnicalAssignmentError && error.code !== 'UNAVAILABLE')
    || (error instanceof Error && ['TECHNICAL_WORK_DENIED', 'TECHNICAL_WORK_STALE'].includes(error.message))) {
    return { ok: false, message: 'La modifica non è stata registrata: dati, incarico o permessi non più validi. Ricarica prima di riprovare.' };
  }
  return { ok: false, uncertain: true, message: 'Esito non confermato. Verifica la ricevuta senza ripetere il salvataggio.' };
}
function json(form: FormData, name: string) {
  const raw = form.get(name);
  if (typeof raw !== 'string' || raw.length > 72_000) throw new TechnicalAssignmentError('DENIED');
  return JSON.parse(raw) as unknown;
}
async function origin() {
  const h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new TechnicalAssignmentError('DENIED');
}
export async function prepareTechnicalWork(_state: TechnicalWorkState, form: FormData): Promise<TechnicalWorkState> {
  const session = await requireSession();
  try {
    await origin();
    const preview = await previewTechnicalWork(prisma, session, technicalTargetReference.parse(json(form, 'target')), json(form, 'command'));
    return { ok: true, message: 'Controlla i soli campi che verranno modificati.', preview };
  } catch (error) { return failure(error); }
}
export async function saveTechnicalWork(_state: TechnicalWorkState, form: FormData): Promise<TechnicalWorkState> {
  const session = await requireSession();
  try {
    await origin();
    const target = technicalTargetReference.parse(json(form, 'target'));
    const receipt = await confirmTechnicalWork(prisma, session, target, json(form, 'command'),
      String(form.get('token') ?? ''), form.get('confirmed') === 'on');
    for (const path of [technicalWorkPath(target), '/technical-work', '/dashboard', '/progress', '/notifications', '/search']) revalidatePath(path);
    return { ok: true, message: 'Modifica registrata. Il referente commerciale e gli altri incarichi sono invariati.',
      outcome: { status: 'RECORDED', receipt } };
  } catch (error) { return failure(error); }
}
export async function checkTechnicalWork(_state: TechnicalWorkState, form: FormData): Promise<TechnicalWorkState> {
  const session = await requireSession();
  try {
    await origin();
    const outcome = await readTechnicalWorkOutcome(prisma, session, technicalTargetReference.parse(json(form, 'target')),
      String(form.get('commandId') ?? ''));
    return outcome.status === 'RECORDED' ? { ok: true, message: 'Modifica già registrata. Non ripetere il salvataggio.', outcome }
      : { ok: false, uncertain: true, message: 'Ricevuta non osservata: attendi la riconciliazione prima di un’altra modifica.', outcome };
  } catch (error) { return { ...failure(error), uncertain: true }; }
}
