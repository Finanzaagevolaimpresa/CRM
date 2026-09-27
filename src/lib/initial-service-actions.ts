'use server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { Prisma } from '@prisma/client';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { requireEnforcedPrivilegedMutation } from './privileged-access';
import { getEngagementDossierReadAccess, mutateInitialServiceWorkflow, reviseEngagementDossier, EngagementDossierError } from './engagement-dossier';
import { buildInitialServiceTemplate, InitialServiceError } from './initial-service-contract';
function value(form: FormData, key: string) { return String(form.get(key) ?? ''); }
export async function mutateInitialServiceAction(form: FormData) {
  const session = await requirePermission('dossier.read'), h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new InitialServiceError('DENIED');
  const dossierId = value(form, 'dossierId'), intent = value(form, 'intent');
  if (intent === 'configure') await requireEnforcedPrivilegedMutation(session, 'M5_WORKFLOW_ASSIGNMENT');
  let result = 'RECORDED';
  try {
    if (intent === 'template') {
      const context = await getEngagementDossierReadAccess(prisma, session, dossierId);
      const state = context?.engagementHistory.initialService;
      if (!context || !state) throw new InitialServiceError('DENIED');
      const content = buildInitialServiceTemplate(state.code, { clientName: context.client.displayName, date: value(form, 'date'),
        revision: state.version.version + 1, sections: Object.fromEntries(state.definition.sections.map((section,index) => [section, value(form, 'section' + index)])),
        sources: [{ title: value(form, 'sourceTitle'), reference: value(form, 'sourceReference'), verifiedAt: value(form, 'sourceDate'), limitation: value(form, 'sourceLimitation') }],
        limits: value(form, 'limits'), nextStep: value(form, 'nextStep') });
      await reviseEngagementDossier(prisma, session, { dossierId, expectedVersionId: value(form, 'expectedVersionId'), title: state.definition.title, content });
    } else if (intent === 'configure') await mutateInitialServiceWorkflow(prisma, session, { dossierId, intent, value: {
      expectedVersionId: value(form, 'expectedVersionId'), expectedPlanHash: value(form, 'expectedPlanHash') || null,
      responsibleUserId: value(form, 'responsibleUserId'), humanReviewerIds: [value(form, 'human1'), value(form, 'human2')].filter(Boolean),
      outputKind: value(form, 'outputKind'), numericAnalysis: form.has('numericAnalysis'), supportingAgents: form.getAll('supportingAgent').map(String),
    } });
    else if (intent === 'review') await mutateInitialServiceWorkflow(prisma, session, { dossierId, intent, value: {
      expectedPlanHash: value(form, 'expectedPlanHash'), expectedVersionId: value(form, 'expectedVersionId'), stage: value(form, 'stage'),
      decision: value(form, 'decision'), note: value(form, 'note'), reference: value(form, 'reference'),
      agentVersionReference: value(form, 'agentVersionReference') || null, documentVersionId: value(form, 'documentVersionId') || null,
    } });
    else throw new InitialServiceError('INVALID');
  } catch (error) {
    if (error instanceof InitialServiceError || error instanceof EngagementDossierError) result = error.code;
    else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') result = 'CONFLICT';
    else if (error instanceof Error && error.name === 'ZodError') result = 'INVALID';
    else throw error;
  }
  revalidatePath('/client-dossiers/' + dossierId);
  redirect('/client-dossiers/' + encodeURIComponent(dossierId) + '?dossierError=' + result);
}
