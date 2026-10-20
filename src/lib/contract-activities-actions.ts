'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { previewContractActivities, confirmContractActivities, readContractActivitiesReceipt } from './contract-activities';
import { ContractActivitiesError } from './contract-activities-contract';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';
import { ProjectUnavailableError } from './project-lifecycle-lock';

async function actor() {
  const session = await requireSession(), h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new ContractActivitiesError('DENIED');
  return session;
}
function failure(error: unknown) {
  const certain = error instanceof ZodError || error instanceof ContractActivitiesError || error instanceof RecordUpdateError
    || error instanceof SerializableConflictError || error instanceof ProjectUnavailableError;
  const message = error instanceof ContractActivitiesError && error.code === 'CLOSED'
    ? 'Le attività sono già presenti oppure il contratto è chiuso o collegato a un servizio. Riapri la scheda per controllare i dati; non creare un contratto duplicato.'
    : certain ? 'Dati o autorizzazioni cambiati. Riapri il modulo e controlla il contratto prima di salvare.'
      : 'Esito non confermato. Usa «Verifica esito» prima di ripetere il salvataggio.';
  return { ok: false as const, uncertain: !certain, message };
}
export async function previewContractActivitiesAction(raw: unknown) {
  try { return { ok: true as const, preview: await previewContractActivities(prisma, await actor(), raw) }; }
  catch (error) { return failure(error); }
}
export async function confirmContractActivitiesAction(raw: unknown, digest: string) {
  try {
    const result = await confirmContractActivities(prisma, await actor(), raw, digest);
    for (const path of ['/contracts', `/contracts/${result.contractId}`, `/contracts/${result.contractId}/activities`,
      `/clients/${result.clientId}`, `/clients/${result.clientId}/services/new`]) revalidatePath(path);
    return { ok: true as const, result };
  } catch (error) { return failure(error); }
}
export async function verifyContractActivitiesAction(clientId: string, contractId: string, commandId: string) {
  try { return { ok: true as const, result: await readContractActivitiesReceipt(prisma, await actor(), clientId, contractId, commandId) }; }
  catch { return { ok: false as const, message: 'Verifica non disponibile. Non ripetere il salvataggio finché l’esito non è chiarito.' }; }
}
