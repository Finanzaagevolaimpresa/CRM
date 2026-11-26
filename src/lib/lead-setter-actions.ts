'use server';
import { revalidatePath } from 'next/cache';
import { requirePermission } from './auth';
import { assertTechnicalServerAction } from './technical-server-guards';
import { prisma } from './prisma';
import { CommercialLeadInboxError } from './commercial-lead-inbox-contract';
import { saveSetterCall } from './commercial-lead-inbox';
import { SetterInputError, type SetterCommand } from './lead-setter-contract';
import { CalendarError } from './personal-calendar-contract';

export async function saveSetterCallAction(input: SetterCommand) {
  await assertTechnicalServerAction("lead-setter-actions:saveSetterCallAction");
  const actor = await requirePermission('lead.write');
  if (!actor.sessionId) return { ok: false, message: 'Accedi nuovamente per registrare la chiamata.' };
  try {
    const receipt = await saveSetterCall(prisma, { userId: actor.userId, sessionId: actor.sessionId }, input);
    for (const path of ['/dashboard','/leads','/leads/inbox','/leads/work','/notifications','/leads/' + input.leadId]) revalidatePath(path);
    return { ok: true, message: receipt.replay ? 'Chiamata già registrata.' : 'Chiamata e prossimo passo salvati.', id: receipt.id };
  } catch (error) {
    if (error instanceof CalendarError) return { ok: false, message: 'Per spostare o annullare la videochiamata collegata usa Appuntamento: il calendario deve verificare la disponibilità del referente.' };
    if (error instanceof SetterInputError) return { ok: false, message: error.message };
    if (error instanceof CommercialLeadInboxError) return { ok: false, message: 'Verifica il referente, lo storico e la versione corrente della scheda prima di riprendere.' };
    throw error;
  }
}
