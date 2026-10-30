import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { syntheticCase, syntheticUser } from '../m5/fixtures';
import { initialServicePlanHash, initialServiceStages } from '../../src/lib/initial-service-contract';
import { authorizeEngagementDossierDelivery, getEngagementDossierReadAccess, mutateInitialServiceWorkflow,
  recordEngagementDossierDelivery, reviewEngagementDossierVersion } from '../../src/lib/engagement-dossier';

export async function adminDossierFixture(db: PrismaClient, admin: AuthSession) {
  const actors = { admin, operator: await syntheticUser(db, 'consulente', 'Operatore sintetico archivio'),
    human1: await syntheticUser(db, 'revisore', 'Revisore sintetico archivio 1'), human2: await syntheticUser(db, 'revisore', 'Revisore sintetico archivio 2') };
  const f = await syntheticCase(db, 'dossier_preanalisi', actors);
  await mutateInitialServiceWorkflow(db, admin, { dossierId: f.dossier.id, intent: 'configure', value: {
    expectedPlanHash: null, expectedVersionId: f.version.id, responsibleUserId: actors.operator.userId,
    humanReviewerIds: [actors.human1.userId], outputKind: 'REPORT', numericAnalysis: false, supportingAgents: [],
  } });
  const plan = (await getEngagementDossierReadAccess(db, admin, f.dossier.id))!.engagementHistory.initialService!.plan!;
  for (const stage of initialServiceStages(plan).stages) {
    const person = stage === 'HUMAN_1' ? actors.human1 : stage === 'HUMAN_2' ? actors.human2 : actors.operator;
    const decision = stage === 'Q02' && !initialServiceStages(plan).q02Required ? 'NOT_APPLICABLE' : 'PASS';
    await mutateInitialServiceWorkflow(db, person, { dossierId: f.dossier.id, intent: 'review', value: {
      expectedPlanHash: initialServicePlanHash(plan), expectedVersionId: f.version.id, stage, decision,
      note: 'Prova sintetica isolata del lifecycle. Nessuna approvazione o attività reale.', reference: 'SYNTHETIC_ADMIN_ARCHIVE_' + stage,
      agentVersionReference: stage.startsWith('HUMAN_') || decision === 'NOT_APPLICABLE' ? null : 'SYNTHETIC_VERSION',
      documentVersionId: stage.startsWith('HUMAN_') ? null : f.documentVersion.id,
    } });
  }
  await reviewEngagementDossierVersion(db, admin, { dossierId: f.dossier.id, versionId: f.version.id,
    versionHash: f.version.contentHash, decision: 'APPROVED', note: 'Revisione del solo dato sintetico per prova di archivio.' });
  const authorization = (address: string) => authorizeEngagementDossierDelivery(db, admin, { dossierId: f.dossier.id,
    versionId: f.version.id, versionHash: f.version.contentHash, recipients: [{ kind: 'CLIENT', name: 'Destinatario sintetico', address, synthetic: true }] });
  const pending = await authorization('pending-admin@example.test'), consumed = await authorization('recorded-admin@example.test');
  const receipt = await recordEngagementDossierDelivery(db, actors.operator, { authorizationId: consumed.id, outcome: 'DELIVERED',
    evidence: { reference: 'SIMULATED_ADMIN_LIFECYCLE_ONLY', deliveredAt: new Date(), synthetic: true } });
  return { ...f, pending, consumed, receipt };
}
