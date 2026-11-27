'use server';
import { cookies, headers } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { requireAuth } from './auth';
import { prisma } from './prisma';
import { assertTechnicalServerAction } from './technical-server-guards';
import { assertOrdinaryEmailRequestOrigin } from './ordinary-email-request-contract';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, requireEnforcedPrivilegedMutation, PrivilegedAdmissionRequired } from './privileged-access';
import { saveWorkflowRule, saveWorkflowTemplate, testWorkflowRule } from './workflow-automations';
import { resolveRomeDateTime } from './rome-date-time';
import { createSyntheticNewsletterRuntime } from './workflow-newsletter-test-runtime';
import { executeWorkflowNewsletter, planWorkflowNewsletter, reconcileWorkflowNewsletterRecipient } from './workflow-newsletters';
import { prepareWorkflowPendingOnce } from './workflow-native-runner';
import { planNativeWorkflowNewsletter, prepareNativeWorkflowNewsletter } from './workflow-newsletter-native';

export async function mutateWorkflowAction(form: FormData) {
  await assertTechnicalServerAction('workflow-automation-actions:mutateWorkflowAction');
  const session = await requireAuth(['admin']), h = await headers();
  let result = 'CHECK_CURRENT';
  const newsletter = String(form.get('kind') ?? '') === 'NEWSLETTER';
  try {
    assertOrdinaryEmailRequestOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site') }, process.env);
    const value = (name: string) => String(form.get(name) ?? '');
    if (value('intent') === 'newsletter-native-plan') {
      await planNativeWorkflowNewsletter(prisma, session, { id: value('runId'), automationId: value('id') });
      result = 'RECORDED';
    } else if (value('intent') === 'newsletter-native-prepare') {
      const mailbox = await prisma.communicationMailbox.findUniqueOrThrow({ where: { id: value('mailboxId') }, select: { id: true, address: true } });
      await prepareNativeWorkflowNewsletter(prisma, session, { runId: value('runId'), mailboxId: mailbox.id, replyTo: mailbox.address });
      result = 'NATIVE_PREPARED';
    } else if (value('intent') === 'native-run') {
      const mailbox = value('mailboxId') ? await prisma.communicationMailbox.findUniqueOrThrow({ where: { id: value('mailboxId') }, select: { id: true, address: true } }) : null;
      const prepared = await prepareWorkflowPendingOnce(prisma, session, { ...(mailbox ? { mailboxId: mailbox.id, replyTo: mailbox.address } : {}), limit: 20 });
      result = prepared.results.some(row => row.error) ? 'NATIVE_REVIEW' : 'NATIVE_PREPARED';
    } else if (value('intent') === 'newsletter-test' || value('intent') === 'newsletter-run') {
      const runtime = await createSyntheticNewsletterRuntime(prisma);
      const run = value('intent') === 'newsletter-test'
        ? await planWorkflowNewsletter(prisma, session, { id: value('runId'), automationId: value('id') }, runtime)
        : { id: value('runId') };
      const scheduled = await prisma.workflowNewsletterRun.findUniqueOrThrow({ where: { id: run.id }, select: { scheduledAt: true } });
      await executeWorkflowNewsletter(prisma, session, { runId: run.id, now: new Date(Math.max(Date.now(), scheduled.scheduledAt.getTime())).toISOString() }, runtime);
      result = 'NEWSLETTER_RECORDED';
    } else if (value('intent') === 'newsletter-reconcile') {
      // UI exposes this only for synthetic runs; recheck the actual parent row.
      await createSyntheticNewsletterRuntime(prisma);
      const recipient = await prisma.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: value('recipientId') }, include: { run: true } });
      if (!recipient.run.synthetic) throw new Error('NEWSLETTER_SYNTHETIC_ONLY');
      await reconcileWorkflowNewsletterRecipient(prisma, session, { id: recipient.id, outcome: value('outcome'), evidence: value('evidence') });
      result = 'NEWSLETTER_RECORDED';
    } else if (value('intent') === 'test') {
      const tested = await testWorkflowRule(prisma, session, { id: value('id'), expectedVersion: Number(value('expectedVersion')) });
      result = tested.passed ? 'TEST_PASSED' : 'TEST_FAILED';
    } else {
      await requireEnforcedPrivilegedMutation(session, 'WORKFLOW_CONFIGURATION', { inline: true });
      const jar = await cookies(), key = await loadActivePrivilegedStepUpKey(prisma);
      const sessionToken = jar.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value;
      const stepUpToken = jar.get(privilegedStepUpCookieName)?.value;
      if (!key || !sessionToken || !stepUpToken) throw new Error('WORKFLOW_DENIED');
      const proof = { key, sessionToken, stepUpToken };
      if (value('intent') === 'template') {
        await saveWorkflowTemplate(prisma, session, { id: randomUUID(), familyId: value('familyId') || randomUUID(),
          expectedVersion: Number(value('expectedVersion')), name: value('name'), purpose: value('purpose'),
          subject: value('subject'), body: value('body'), state: value('state'), authorizationReference: value('authorizationReference') || null }, proof);
      } else if (value('intent') === 'rule') {
        const kind = value('event') === 'NEWSLETTER' ? 'NEWSLETTER' : 'INDIVIDUAL';
        const planned = resolveRomeDateTime(value('newsletterAt'));
        if (kind === 'NEWSLETTER' && planned.kind !== 'unique') throw new Error('WORKFLOW_TIME_INVALID');
        await saveWorkflowRule(prisma, session, { id: value('id') || randomUUID(), expectedVersion: Number(value('expectedVersion')),
          name: value('name'), event: value('event'), state: value('state'), delayMinutes: Number(value('delayMinutes')),
          configuration: { kind, action: value('action'), confirmationTemplateId: value('confirmationTemplateId'),
            followupTemplateId: value('followupTemplateId') || null, requireAssociated: true, stopOnReply: true, stopOnAppointment: true,
            newsletterAt: planned.kind === 'unique' ? planned.instants[0] : null,
            recipientIds: kind === 'NEWSLETTER' ? form.getAll('recipientIds').map(String) : [] } }, proof);
      } else throw new Error('WORKFLOW_INVALID');
      result = 'RECORDED';
    }
    revalidatePath('/automations');
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) result = 'STEP_UP_REQUIRED';
    else unstable_rethrow(error);
  }
  redirect('/automations?result=' + result + (newsletter ? '&kind=NEWSLETTER' : ''));
}
