'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { previewServiceRegistration, confirmServiceRegistration, readServiceRegistrationReceipt } from './client-service-registration';
import { ServiceRegistrationError } from './client-service-registration-contract';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';
import { ProjectUnavailableError } from './project-lifecycle-lock';

async function actor() {
  const session = await requireSession(), h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new ServiceRegistrationError('DENIED');
  return session;
}
function failure(error: unknown) {
  const certain = error instanceof ZodError || error instanceof ServiceRegistrationError || error instanceof RecordUpdateError
    || error instanceof SerializableConflictError || error instanceof ProjectUnavailableError;
  const message = error instanceof ServiceRegistrationError && error.code === 'DUPLICATE'
    ? 'Questo servizio è già registrato per l’incarico. Torna al fascicolo per aprirlo.'
    : error instanceof ServiceRegistrationError && error.code === 'CLOSED'
      ? 'Il servizio ha già un pagamento o una lavorazione avviata. I collegamenti non possono essere sostituiti da questo modulo.'
      : certain ? 'Dati o permessi non più disponibili. Verifica incarico firmato, rata incassata e data di acquisto; poi ricarica il modulo.'
        : 'Esito non confermato. Usa «Verifica esito» prima di effettuare un altro salvataggio.';
  return { ok: false as const, uncertain: !certain, message };
}
export async function previewServiceRegistrationAction(raw: unknown) {
  const session = await actor();
  try { return { ok: true as const, preview: await previewServiceRegistration(prisma, session, raw) }; }
  catch (error) { return failure(error); }
}
export async function confirmServiceRegistrationAction(raw: unknown, digest: string) {
  const session = await actor();
  try {
    const result = await confirmServiceRegistration(prisma, session, raw, digest);
    revalidatePath(`/clients/${result.clientId}`); revalidatePath(`/services/${result.serviceId}/handoff`);
    revalidatePath(`/clients/${result.clientId}/services/new`); revalidatePath('/clients');
    return { ok: true as const, result };
  } catch (error) { return failure(error); }
}
export async function verifyServiceRegistrationAction(clientId: string, commandId: string) {
  const session = await actor();
  try { return { ok: true as const, result: await readServiceRegistrationReceipt(prisma, session, clientId, commandId) }; }
  catch { return { ok: false as const, message: 'Verifica non disponibile. Non ripetere il salvataggio finché l’esito non è chiarito.' }; }
}
