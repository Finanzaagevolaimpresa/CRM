'use server';
import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, requireEnforcedPrivilegedMutation, PrivilegedAdmissionRequired } from './privileged-access';
import { TechnicalAssignmentError } from './technical-assignment-transaction';
import { technicalTargetReference, technicalManagementPath } from './technical-assignment-display';
import { previewPrivateTechnicalItem, confirmPrivateTechnicalItem, readPrivateTechnicalItemOutcome } from './technical-private-item-service';
import type { TechnicalPrivateItemState } from './technical-private-item-ui-state';

function json(form: FormData, field: string) {
  const raw = form.get(field);
  if (typeof raw !== 'string' || raw.length > 48_000) throw new TechnicalAssignmentError('DENIED');
  return JSON.parse(raw) as unknown;
}
async function origin() {
  const h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new TechnicalAssignmentError('DENIED');
}
async function proof() {
  const store = await cookies(), key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) throw new TechnicalAssignmentError('UNAVAILABLE');
  return { key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
    stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' };
}
export async function preparePrivateTechnicalItem(_state: TechnicalPrivateItemState, form: FormData): Promise<TechnicalPrivateItemState> {
  const session = await requireSession();
  try { await origin();
    await requireEnforcedPrivilegedMutation(session, 'TECHNICAL_ASSIGNMENT_MANAGE', { inline: true });
    const preview = await previewPrivateTechnicalItem(prisma, session, await proof(), json(form, 'command'));
    return { ok: true, message: 'Controlla il contenuto prima di creare l’elemento privato.', preview };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) return error.formState;
    return { ok: false, message: 'Riepilogo non disponibile. Verifica i dati e ricarica per controllare sessione, contesto e permessi.' };
  }
}
export async function savePrivateTechnicalItem(_state: TechnicalPrivateItemState, form: FormData): Promise<TechnicalPrivateItemState> {
  const session = await requireSession();
  try { await origin();
    await requireEnforcedPrivilegedMutation(session, 'TECHNICAL_ASSIGNMENT_MANAGE', { inline: true });
    const receipt = await confirmPrivateTechnicalItem(prisma, session, await proof(), json(form, 'command'),
      String(form.get('token') ?? ''), form.get('confirmed') === 'on');
    revalidatePath(technicalManagementPath(receipt.target));
    return { ok: true, message: 'Elemento privato creato. Puoi ora scegliere separatamente chi potrà utilizzarlo.', outcome: { status: 'RECORDED', receipt } };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) return error.formState;
    return { ok: false, uncertain: true, message: 'Esito non confermato. Verifica la ricevuta prima di creare un altro elemento.' };
  }
}
export async function checkPrivateTechnicalItem(_state: TechnicalPrivateItemState, form: FormData): Promise<TechnicalPrivateItemState> {
  const session = await requireSession();
  try { await origin();
    const outcome = await readPrivateTechnicalItemOutcome(prisma, session, technicalTargetReference.parse(json(form, 'target')),
      String(form.get('commandId') ?? ''));
    return outcome.status === 'RECORDED'
      ? { ok: true, message: 'Creazione già registrata. L’elemento resta privato finché non scegli chi potrà utilizzarlo.', outcome }
      : { ok: false, uncertain: true, message: 'Ricevuta non osservata. Attendi la riconciliazione senza ripetere la creazione.', outcome };
  } catch { return { ok: false, uncertain: true, message: 'Esito non disponibile con la sessione e il contesto correnti. Non ripetere la creazione.' }; }
}
