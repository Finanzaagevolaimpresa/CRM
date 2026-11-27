import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { collectionKey } from '../payment-collection/fixture';
import { clientProof } from '../selective-clients/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticIntakeFixture } from './fixture';
import { configureCommunicationMailbox,qualifyCommunicationMailbox } from '../../src/lib/approved-communications';
import { saveWorkflowRule,saveWorkflowTemplate } from '../../src/lib/workflow-automations';
import { createSyntheticNewsletterRuntime,SYNTHETIC_NEWSLETTER_KEY } from '../../src/lib/workflow-newsletter-test-runtime';
import { PROPOSED_POLICY } from '../../src/lib/marketing-preferences/policy';
import { parseNativeNewsletterPolicy } from '../../src/lib/workflow-newsletter-policy';
import { registerWorkflowServiceCredential,issueWorkflowServiceGrant } from '../../src/lib/workflow-service-authority';
import { serviceFingerprint } from '../../src/lib/workflow-service-contract';
import { ordinaryTransportQualificationReference } from '../../src/lib/ordinary-email-transport-binding';
import { sealOrdinaryObservation,type OrdinaryObservationSink,type SealedOrdinaryObservation } from '../../src/lib/ordinary-email-observation';

export const serviceTestEnvironment = { DIRECT_EMAIL_TEST_MODE: 'enforced',DIRECT_EMAIL_TEST_REFERENCE: 'R49_EMAIL_DIRECT_20260930_01',
  DIRECT_EMAIL_TEST_SMTP_HOST: 'authsmtp.securemail.pro',DIRECT_EMAIL_TEST_SMTP_PASSWORD: 'SYNTHETIC_WORKFLOW_SERVICE_TLS_ONLY' };
export async function serviceFixture(db: PrismaClient) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); assert.equal(process.env.APP_ENV,'test'); await collectionKey(db);
  const admin = await syntheticPerson(db,'Autorità delega R1 sintetica','admin'), intake = await syntheticIntakeFixture(db,admin.user.id);
  const prior = await db.ordinaryEmailAuthority.findUnique({ where: { id: 'ordinary-email' } });
  const original = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'comunicazioni@finanzaagevolaimpresa.it' } });
  const mailbox = await configureCommunicationMailbox(db,admin.session,{ mailboxId: original.id,expectedRevision: original.revision,kind: 'MAILBOX',canonicalMailboxId: null,
    responsibleUserId: admin.user.id,providerReference: 'register_it',configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT',canSend: true,canReceive: true,restricted: false });
  await qualifyCommunicationMailbox(db,admin.session,{ mailboxId: mailbox.id,expectedRevision: mailbox.revision,action: 'TEST',testReference: 'SYNTHETIC_SERVICE_TLS_ONLY' });
  await qualifyCommunicationMailbox(db,admin.session,{ mailboxId: mailbox.id,expectedRevision: mailbox.revision,action: 'ENABLE' });
  await db.$executeRaw`INSERT INTO "OrdinaryEmailAuthority" (id,"userId","mailboxId",enabled) VALUES ('ordinary-email',${admin.user.id},${mailbox.id}::uuid,true)
    ON CONFLICT (id) DO UPDATE SET "userId"=EXCLUDED."userId","mailboxId"=EXCLUDED."mailboxId",enabled=true,revision="OrdinaryEmailAuthority".revision+1`;
  const previousChannel = await db.ordinaryEmailChannel.findUnique({ where: { mailboxId: mailbox.id } }), revision = (previousChannel?.revision ?? 0)+1;
  const channel = { purpose: 'ORDINARY_SMTP' as const,mailboxId: mailbox.id,mailboxRevision: mailbox.revision,address: 'comunicazioni@finanzaagevolaimpresa.it' as const,
    providerReference: 'register_it' as const,configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT' as const,channelRevision: revision,qualificationReference: 'PENDING_SYNTHETIC' };
  const reference = ordinaryTransportQualificationReference(channel,clientProof(admin).key,serviceTestEnvironment);
  await db.$executeRaw`INSERT INTO "OrdinaryEmailChannel" ("mailboxId","mailboxRevision","qualificationReference",enabled,revision)
    VALUES (${mailbox.id}::uuid,${mailbox.revision},${reference},true,${revision}) ON CONFLICT ("mailboxId") DO UPDATE SET
    "mailboxRevision"=EXCLUDED."mailboxRevision","qualificationReference"=EXCLUDED."qualificationReference",enabled=true,revision=EXCLUDED.revision`;
  await db.$executeRaw`INSERT INTO "MarketingPreferenceEpoch" (singleton,epoch,reconciled) VALUES (true,${randomUUID()}::uuid,true) ON CONFLICT (singleton) DO NOTHING`;
  const [epoch] = await db.$queryRaw<Array<{ epoch: string }>>`SELECT epoch FROM "MarketingPreferenceEpoch" WHERE singleton=true`;
  const notices = await db.privacyNoticeVersion.findMany({ where: { noticeCode: { startsWith: 'FLOW_MARKETING_' },status: 'ACTIVE' },select: { id: true,contentHash: true } });
  const policy = { protocol: 'FAI_NEWSLETTER_NATIVE_POLICY_V1',policyVersion: PROPOSED_POLICY.version,approvalReference: 'SYNTHETIC_SERVICE_MARKETING_ONLY',qualificationReference: 'SYNTHETIC_SERVICE_TLS_ONLY',
    effectiveFrom: new Date(Date.now()-60000).toISOString(),effectiveUntil: new Date(Date.now()+3600000).toISOString(),purposeOpen: true,epoch: epoch.epoch,
    keyFingerprint: createHash('sha256').update(SYNTHETIC_NEWSLETTER_KEY).digest('hex'),keyPath: '/synthetic/not-provisioned',maxTicketAgeMs: 60000,
    approvedEmailNotices: notices.map(row => ({ noticeVersionId: row.id,contentHash: row.contentHash })),unsubscribeUrl: 'https://example.test/preferenze-email',unsubscribeQualificationReference: 'SYNTHETIC_SERVICE_OPTOUT_ONLY' };
  const policySource = async (now: Date) => parseNativeNewsletterPolicy(policy,SYNTHETIC_NEWSLETTER_KEY,now);
  const preferences = (await createSyntheticNewsletterRuntime(db)).preferences;
  const credential = { id: randomUUID(),key: Buffer.alloc(32,37) };
  await registerWorkflowServiceCredential(db,admin.session,{ id: credential.id,keyFingerprint: serviceFingerprint(credential.key),validUntil: new Date(Date.now()+3600000).toISOString(),
    qualificationReference: 'SYNTHETIC_SERVICE_KEY_ONLY',approved: true },clientProof(admin));
  const observations = new Map<string,SealedOrdinaryObservation>();
  const observationSink: OrdinaryObservationSink = async (lease,request,result,observedAt) => { observations.set(request.attemptId,sealOrdinaryObservation(lease,request,result,observedAt)); };
  const runtime = { credential,nativeKey: clientProof(admin).key,newsletterPolicySource: policySource,observationSink,assertCredentialCurrent: async () => {
    await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  } };
  async function create(kind: 'LEAD_ACCEPTED'|'NEWSLETTER'|'APPOINTMENT_BOOKED'|'ASSIGNMENT_CONFIRMED'|'STATUS_CHANGED'|'DOCUMENT_REQUESTED' = 'LEAD_ACCEPTED', options: { followup?: boolean;internal?: boolean;maxMessages?: number;maxPerDay?: number;newsletterDelayMs?: number;validityMs?: number } = {}) {
    const confirmation = { id: randomUUID(),familyId: randomUUID(),expectedVersion: 0,name: 'Modello delega sintetico',purpose: options.internal ? 'INTERNAL_NOTICE' : kind === 'NEWSLETTER' ? 'NEWSLETTER' : kind === 'APPOINTMENT_BOOKED' ? 'APPOINTMENT' : kind === 'DOCUMENT_REQUESTED' ? 'DOCUMENT_REQUEST' : 'CONFIRMATION',
      subject: 'Ricevuta {{companyName}}',body: kind === 'NEWSLETTER' ? 'Ciao {{firstName}}. Preferenze {{unsubscribeUrl}}' : kind === 'APPOINTMENT_BOOKED' ? 'Appuntamento {{appointmentAt}}' : kind === 'DOCUMENT_REQUESTED' ? 'Documenti: {{documentList}}' : 'Ciao {{firstName}}.',state: 'PUBLISHED',authorizationReference: 'SYNTHETIC_SERVICE_TEMPLATE_ONLY' };
    await saveWorkflowTemplate(db,admin.session,confirmation,clientProof(admin));
    const followup = options.followup ? { ...confirmation,id: randomUUID(),familyId: randomUUID(),purpose: options.internal ? 'INTERNAL_NOTICE' : kind === 'APPOINTMENT_BOOKED' ? 'APPOINTMENT' : 'FOLLOW_UP',subject: 'Sollecito {{companyName}}' } : null;
    if (followup) await saveWorkflowTemplate(db,admin.session,followup,clientProof(admin));
    const newsletterLead = kind === 'NEWSLETTER' ? await intake.receive(false,'GRANTED') : null;
    if (newsletterLead) {
      const evidence = await db.privacyEvidenceReceipt.findFirstOrThrow({ where: { businessInboxEventId: newsletterLead.receipt.inboxEventId,purposeCode: 'DIRECT_MARKETING' } });
      assert.equal(await (preferences as import('../../src/lib/marketing-preferences/service').MarketingPreferences).recordChoice(evidence.id,intake.marketingNoticeText),'RECORDED');
    }
    const rule = { id: randomUUID(),expectedVersion: 0,name: 'Regola delega sintetica',event: kind,state: 'ACTIVE',delayMinutes: 1,
      configuration: { kind: kind === 'NEWSLETTER' ? 'NEWSLETTER' : 'INDIVIDUAL',action: options.internal ? 'INTERNAL_NOTICE' : 'EMAIL',confirmationTemplateId: confirmation.id,followupTemplateId: followup?.id ?? null,
        requireAssociated: true,stopOnReply: true,stopOnAppointment: true,newsletterAt: newsletterLead ? new Date(Date.now()+(options.newsletterDelayMs ?? 500)).toISOString() : null,
        recipientIds: newsletterLead ? [newsletterLead.projection.leadId!] : [] } };
    await saveWorkflowRule(db,admin.session,rule,clientProof(admin));
    const input = { id: randomUUID(),automationId: rule.id,expectedVersion: 1,credentialId: credential.id,
      validFrom: new Date(Date.now()-1000).toISOString(),validUntil: new Date(Date.now()+(options.validityMs ?? 1800000)).toISOString(),maxMessages: options.maxMessages ?? 20,
      maxPerDay: options.maxPerDay ?? options.maxMessages ?? 20,approvalReference: 'SYNTHETIC_PREVENTIVE_APPROVAL_ONLY',approved: true };
    const grant = await issueWorkflowServiceGrant(db,admin.session,input,clientProof(admin),policySource);
    const received = newsletterLead ?? await intake.receive();
    return { grant,rule,input,received,confirmation,followup };
  }
  const restore = async () => {
    if (prior) await db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET "userId"=${prior.userId},"mailboxId"=${prior.mailboxId}::uuid,enabled=${prior.enabled},revision=revision+1 WHERE id='ordinary-email'`;
    else await db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET enabled=false,revision=revision+1 WHERE id='ordinary-email'`;
  };
  return { admin,intake,mailbox,credential,runtime,policy,observations,preferences: preferences as import('../../src/lib/marketing-preferences/service').MarketingPreferences,create,restore };
}
