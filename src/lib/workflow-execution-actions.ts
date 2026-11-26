'use server';
import { headers } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAuth } from './auth';
import { prisma } from './prisma';
import { assertTechnicalServerAction } from './technical-server-guards';
import { assertOrdinaryEmailRequestOrigin } from './ordinary-email-request-contract';
import { enrollSyntheticWorkflowReceipt, runSyntheticWorkflowEnrollment } from './workflow-executions';
import { planWorkflowOperationalEvent } from './workflow-event-planner';

function operationalEventInput(form: FormData, leadId: string) {
  const version = String(form.get('sourceVersion') ?? ''), origin = String(form.get('sourceOrigin') ?? '');
  return { automationId: form.get('automationId'), expectedLeadVersion: form.get('leadVersion'),
    source: { kind: form.get('sourceKind'), leadId, referenceId: form.get('sourceId'),
      ...(version ? { referenceVersion: Number(version) } : {}), ...(origin ? { origin } : {}),
      ...(form.get('sourceKind') === 'DOCUMENT_REQUESTED'
        ? { documents: String(form.get('documents') ?? '').split(/\r?\n/).map(row => row.trim()).filter(Boolean) } : {}) } };
}

export async function runWorkflowNativeEventAction(form: FormData) {
  await assertTechnicalServerAction('workflow-execution-actions:runWorkflowNativeEventAction');
  const session = await requireAuth(['admin']), h = await headers();
  const leadId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).parse(form.get('leadId'));
  let result = 'CHECK_CURRENT';
  try {
    assertOrdinaryEmailRequestOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site') }, process.env);
    await planWorkflowOperationalEvent(prisma, session, operationalEventInput(form, leadId));
    result = 'RECORDED'; revalidatePath('/leads/' + leadId); revalidatePath('/automations');
  } catch (error) { unstable_rethrow(error); }
  redirect('/leads/' + leadId + '?workflow=' + result);
}

export async function runWorkflowSyntheticAction(form: FormData) {
  await assertTechnicalServerAction('workflow-execution-actions:runWorkflowSyntheticAction');
  const session = await requireAuth(['admin']), h = await headers();
  const leadId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).parse(form.get('leadId'));
  let result = 'CHECK_CURRENT';
  try {
    assertOrdinaryEmailRequestOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site') }, process.env);
    if (form.get('intent') === 'enroll') {
      const receiptId = z.string().uuid().parse(form.get('receiptId'));
      // The form's route target must be the same lead bound to the receipt.
      const receipt = await prisma.secureLeadGatewayReceipt.findFirst({ where: { id: receiptId,
        inboxEvent: { leadProjectionLedger: { is: { leadId } } } }, select: { id: true } });
      if (!receipt) throw new Error('WORKFLOW_CONTEXT_MISMATCH');
      const enrolled = await enrollSyntheticWorkflowReceipt(prisma, session, { receiptId, automationId: form.get('automationId') });
      await runSyntheticWorkflowEnrollment(prisma, session, { enrollmentId: enrolled.id, now: new Date().toISOString() });
    } else if (form.get('intent') === 'event-enroll') {
      const enrolled = await planWorkflowOperationalEvent(prisma, session, operationalEventInput(form, leadId), true);
      await runSyntheticWorkflowEnrollment(prisma, session, { enrollmentId: enrolled.id, now: new Date().toISOString() });
    } else if (form.get('intent') === 'run') {
      const enrollmentId = z.string().uuid().parse(form.get('enrollmentId'));
      const enrollment = await prisma.workflowEnrollment.findFirst({ where: { id: enrollmentId, leadId, synthetic: true }, select: { id: true } });
      if (!enrollment) throw new Error('WORKFLOW_CONTEXT_MISMATCH');
      await runSyntheticWorkflowEnrollment(prisma, session, { enrollmentId, now: new Date().toISOString() });
    } else throw new Error('WORKFLOW_INVALID');
    result = 'RECORDED';
    revalidatePath('/leads/' + leadId);
  } catch (error) { unstable_rethrow(error); }
  redirect('/leads/' + leadId + '?workflow=' + result);
}
