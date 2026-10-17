'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ZodError } from 'zod';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { requireEnforcedPrivilegedMutation, privilegedStepUpCookieName } from './privileged-access';
import { transitionLeadLifecycle } from './lead-lifecycle';
import { LeadLifecycleError } from './lead-lifecycle-lock';

export async function changeLeadLifecycle(_previous: { ok: boolean; message: string }, form: FormData) {
  const session = await requirePermission('lead.write');
  await requireEnforcedPrivilegedMutation(session, 'LEAD_LIFECYCLE');
  const store = await cookies();
  let destination: string;
  try {
    const key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) throw new LeadLifecycleError('DENIED');
    const result = await transitionLeadLifecycle(prisma, session, Object.fromEntries(
      ['id', 'updatedAt', 'action', 'confirmed', 'reasonCode'].map(name => [name, form.get(name) ?? ''])), {
      key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '',
    });
    for (const path of ['/leads', '/leads/trash', '/leads/inbox', '/leads/duplicates', '/dashboard',
      '/commercial-offers', '/practice-readiness', '/controlled-intakes', '/notifications', `/leads/${result.id}`]) revalidatePath(path);
    destination = result.state === 'trash' ? '/leads/trash?result=trashed' : `/leads/${result.id}?result=restored`;
  } catch (error) {
    if (error instanceof LeadLifecycleError) return { ok: false, message: error.message };
    if (error instanceof ZodError) return { ok: false, message: 'Conferma le conseguenze prima di procedere.' };
    return { ok: false, message: 'Esito non confermato. Ricarica la pagina e verifica lo stato prima di riprovare.' };
  }
  redirect(destination);
}
