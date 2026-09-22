'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma } from '@prisma/client';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { authorizeEngagementDossierDelivery, createEngagementDossier, EngagementDossierError, recordEngagementDossierDelivery, reviewEngagementDossierVersion, reviseEngagementDossier } from './engagement-dossier';

async function execute(form: FormData, operation: (actor: Awaited<ReturnType<typeof requirePermission>>, value: Record<string, unknown>) => Promise<unknown>) {
  const actor = await requirePermission('dossier.read');
  const value = Object.fromEntries(form.entries()) as Record<string, unknown>;
  try { return await operation(actor, value); }
  catch (error) {
    const code = error instanceof EngagementDossierError ? error.code
      : error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' ? 'CONFLICT' : null;
    if (!code) throw error;
    const dossierId = String(value.dossierId ?? '');
    const practiceId = String(value.practiceReadinessId ?? '');
    const destination = dossierId ? `/client-dossiers/${dossierId}` : practiceId ? `/engagement-dossiers/new/${practiceId}` : '/practice-readiness';
    redirect(`${destination}?dossierError=${code}`);
  }
}
export async function createEngagementDossierAction(form: FormData) {
  const result = await execute(form, (actor, value) => createEngagementDossier(prisma, actor, value)) as Awaited<ReturnType<typeof createEngagementDossier>>;
  revalidatePath('/practice-readiness'); redirect(`/client-dossiers/${result.dossier.id}`);
}
export async function reviseEngagementDossierAction(form: FormData) {
  await execute(form, (actor, value) => reviseEngagementDossier(prisma, actor, value));
  revalidatePath(`/client-dossiers/${String(form.get('dossierId'))}`);
}
export async function reviewEngagementDossierVersionAction(form: FormData) {
  await execute(form, (actor, value) => reviewEngagementDossierVersion(prisma, actor, value)); revalidatePath(`/client-dossiers/${String(form.get('dossierId'))}`);
}
export async function authorizeEngagementDossierDeliveryAction(form: FormData) {
  const recipients = [{ kind: String(form.get('recipientKind')), name: String(form.get('recipientName')), address: String(form.get('recipientAddress')), synthetic: form.get('recipientSynthetic') === 'on' }];
  await execute(form, (actor, value) => authorizeEngagementDossierDelivery(prisma, actor, { ...value, recipients })); revalidatePath(`/client-dossiers/${String(form.get('dossierId'))}`);
}
export async function recordEngagementDossierDeliveryAction(form: FormData) {
  const evidence = { reference: String(form.get('reference')), deliveredAt: String(form.get('deliveredAt')), synthetic: form.get('evidenceSynthetic') === 'on', note: String(form.get('note') ?? '') || undefined };
  const authorizationId = String(form.get('authorizationId'));
  await execute(form, (actor, value) => recordEngagementDossierDelivery(prisma, actor, { ...value, authorizationId, evidence })); revalidatePath(`/client-dossiers/${String(form.get('dossierId'))}`);
}
