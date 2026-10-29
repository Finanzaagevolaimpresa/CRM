const ADMIN_RECORD_MIGRATION = '20261029190000_admin_record_revisions_v1';
const ADMIN_RECORD_MIGRATION_SHA256 = 'a045c396f89c18100d485d4427261c5810d6dc11bea3282122a5c859a5386395';
const RECORD_REMINDER_MIGRATION = '20261028180000_record_deadline_reminders_v1';
const RECORD_REMINDER_MIGRATION_SHA256 = 'dfc159e99ab00a8587fe5c50834fd4d651b25ff14d1a9aa5a0b7731abf9652f6';
const HISTORICAL_CONTACT_MIGRATION = '20261027220000_historical_lead_contact_v1';
const HISTORICAL_CONTACT_MIGRATION_SHA256 = '7cfd6093caca8fbdf022aa66720c8bf6b38d1a04b1f599a80f66505c5e3edf4c';
const TECHNICAL_PRIVATE_ITEM_MIGRATION = '20261027010000_technical_private_items_v1';
const TECHNICAL_PRIVATE_ITEM_MIGRATION_SHA256 = 'f8b1cd77f86fbe5c170bd81c92b5a04cf3c5f1832041071c87ec750c5fd811ce';
const TECHNICAL_ACQUISITION_MIGRATION = '20261024190000_technical_document_acquisition_v1';
const TECHNICAL_ACQUISITION_MIGRATION_SHA256 = '9ac78fa51a45db97d38725d0df8dd17812abfcf60acbbf6de7f70cd7e0f4d4f9';
const TECHNICAL_UPLOAD_MIGRATION = '20261024160000_technical_document_upload_v1';
const TECHNICAL_UPLOAD_MIGRATION_SHA256 = '8f961cde28d543f0e515fc03898ae9edd0e67a98f373e7805ce4a7c258202d0a';
const TECHNICAL_WORK_ITEM_MIGRATION = '20261024090000_technical_work_items_v1';
const TECHNICAL_WORK_ITEM_MIGRATION_SHA256 = '7facd68cdc4c943554fdf3b68f2e773b9609aa02bee1b427f29b9b177c130636';
const ADMIN_REQUEST_MIGRATION = '20261023160000_admin_request_queue_v1';
const ADMIN_REQUEST_MIGRATION_SHA256 = 'f25dd5563bcfc8ecf165bf0c4929ad70c6023dff8e35a5292ce2f1dd94833f06';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { ordinaryTransportQualificationReference } from './ordinary-email-transport-binding';
import { inboundQualificationReference, type InboundDescriptor } from './ordinary-email-inbound-contract';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uint = z.string().regex(/^[1-9][0-9]{0,9}$/).refine(v => Number(v) <= 4_294_967_295);
export const ordinaryActivationSchema = z.object({
  protocol: z.literal('FAI_ORDINARY_EMAIL_ACTIVATION_V1'),
  targetDatabase: z.enum(['fai_crm', 'fai_crm_test']),
  userId: z.string().cuid(), mailboxId: z.string().uuid(), mailboxRevision: z.number().int().positive(),
  responsibleUserId: z.string().cuid(), streamId: z.string().uuid(),
  historyScope: z.enum(['NEW_FROM_ACTIVATION', 'EXISTING_INBOX']),
  generation: uint, observedUidNext: uint, observedAt: z.string().datetime(),
  validUntil: z.string().datetime(),
  authorityReference: z.string().regex(/^[A-Z][A-Z0-9_-]{5,127}$/),
  personalBindingAuthorized: z.literal(true), receptionAuthorized: z.literal(true),
  authorityEvidenceSha256: hash, smtpQualificationSha256: hash, imapQualificationSha256: hash,
}).strict();
export type OrdinaryActivationPlan = z.infer<typeof ordinaryActivationSchema>;
function denied(): never { throw new Error('ORDINARY_EMAIL_ACTIVATION_DENIED'); }
const MIGRATION = '20261017120000_ordinary_email_v1';
const MIGRATION_SHA256 = '74b6a8e88c8732012656420b4d6aabbc17c2054ae13935f5f5879042e8483a83';
const CONTEXT_MIGRATION = '20261017160000_admin_email_contexts_v1';
const CONTEXT_MIGRATION_SHA256 = '614f3a2c329892f2732c9e788c1f120662f30ea9c01edea9ff0192a087d9f026';
const UPDATES_MIGRATION = '20261017200000_record_update_notifications_v1';
const UPDATES_MIGRATION_SHA256 = '11df35b3e90d69aa535104fcc8b15eb32ed218691c40dd85409cc51edf2a3ef0';

const VIDEOS_MIGRATION = '20261018000000_private_video_library_v1';
const VIDEOS_MIGRATION_SHA256 = 'e61fd5ba2a6a9139a60155642fc4c473dd5e3523b24f2fccfff3879be7f9ebfc';

const UPDATE_EMAIL_MIGRATION = '20261018060000_record_update_email_drafts_v1';
const UPDATE_EMAIL_MIGRATION_SHA256 = '91fa5bb389f9d5f9bf61f4cbb156d36de4aa48ddb5d75f41bf305849962dcee4';

const SELECTIVE_LEAD_MIGRATION = '20261018140000_selective_lead_read_v1';
const SELECTIVE_LEAD_MIGRATION_SHA256 = '29053ccb2bb289b24f34b18db9181019518e6dd39e83e7fac7dc49a5dbdde5d4';
const SELECTIVE_CLIENT_MIGRATION = '20261018190000_selective_client_read_v1';
const SELECTIVE_CLIENT_MIGRATION_SHA256 = '55cdaf7e5c714d1fc498ce2bf5131dedc1f05bbafdbb61de5d8dde7ffa753299';

const SELECTIVE_PRACTICE_MIGRATION = '20261018220000_selective_practice_read_v1';
const SELECTIVE_PRACTICE_MIGRATION_SHA256 = '98ccebc553699d31ffbfa9cbdf7de028482c7decc4efe5cf0ef099eee54fa550';

const SELECTIVE_DOCUMENT_MIGRATION = '20261021080000_selective_client_documents_v1';
const SELECTIVE_DOCUMENT_MIGRATION_SHA256 = '1890bda902d186dd8ea1b84cac2b46b9412e0740c1cf02b413384f086761f053';

const SELECTIVE_PRACTICE_DOCUMENT_MIGRATION = '20261021110000_selective_practice_documents_v1';
const SELECTIVE_PRACTICE_DOCUMENT_MIGRATION_SHA256 = '3c5be559feca7757ed3e3e9ff56a312489303b896f5a984cc99c571cbc3be791';

const SELECTIVE_COMPANY_MIGRATION = '20261021170000_selective_client_company_fields_v1';
const SELECTIVE_COMPANY_MIGRATION_SHA256 = '9c65f0a874c1abdb6529fa87e2a9dac2c991c7412fbc9e795a18d89968fc7fd5';

const SELECTIVE_PERSON_MIGRATION = '20261021220000_selective_client_person_fields_v1';
const SELECTIVE_PERSON_MIGRATION_SHA256 = '984a2706bf907492c01aac9ae04889471918244ebeb816564854c9ccc29b0603';

const SELECTIVE_LEAD_EDIT_MIGRATION = '20261022110000_selective_lead_edit_v1';
const SELECTIVE_LEAD_EDIT_MIGRATION_SHA256 = '4534f290bc80f9b41f1c4de1f9df8d88f7402c02c0604797351c07e187c6961c';
const TECHNICAL_ASSIGNMENT_MIGRATION = '20261022200000_technical_assignments_v1';
const TECHNICAL_ASSIGNMENT_MIGRATION_SHA256 = '9b3a7b1cab3cd97df9c110bff4b7590f7bee8acaabe7e985e3bfbfba3f5b7583';

/** A privileged, explicitly invoked operational act, never a public action.
 * The operator must acquire the human binding/scope and real TLS/authentication
 * evidence first. Hashing that act does not create its authority. The CLI
 * requires the separately reviewed plan hash. No session is impersonated,
 * no network is opened and no existing authority or cursor is overwritten. */
export async function activateOrdinaryEmail(db: Pick<PrismaClient, '$transaction'>, input: unknown,
  expectedPlanHash: string, key: PrivilegedStepUpKey,
  environment: Readonly<Record<string, string | undefined>>) {
  const parsed = ordinaryActivationSchema.safeParse(input);
  if (!parsed.success || !hash.safeParse(expectedPlanHash).success || canonicalSha256(parsed.data) !== expectedPlanHash) denied();
  const plan = parsed.data;
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('FAI_ORDINARY_EMAIL_ACTIVATION_V1'))`;
    if (!await lockRegisteredPrivilegedStepUpKey(tx, key)) denied();
    const [state] = await tx.$queryRaw<Array<{ database: string; count: number; complete: boolean; checksum: string | null; contextChecksum: string | null; updatesChecksum: string | null; videosChecksum: string | null; updateEmailChecksum: string | null; selectiveLeadChecksum: string | null; selectiveClientChecksum: string | null; selectivePracticeChecksum: string | null; selectiveDocumentChecksum: string | null; selectivePracticeDocumentChecksum: string | null; selectiveCompanyChecksum: string | null; selectivePersonChecksum: string | null; selectiveLeadEditChecksum: string | null; adminRequestChecksum: string; technicalWorkItemChecksum: string; technicalUploadChecksum: string; technicalAcquisitionChecksum: string; adminRecordChecksum: string; recordReminderChecksum: string; historicalContactChecksum: string; technicalPrivateItemChecksum: string; technicalAssignmentChecksum: string | null; now: Date }>>`
      SELECT current_database() AS database, clock_timestamp() AS now,
        (SELECT count(*)::integer FROM "_prisma_migrations") AS count,
        (SELECT bool_and(finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1) FROM "_prisma_migrations") AS complete,
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${MIGRATION}) AS checksum,
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${CONTEXT_MIGRATION}) AS "contextChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${UPDATES_MIGRATION}) AS "updatesChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${VIDEOS_MIGRATION}) AS "videosChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${UPDATE_EMAIL_MIGRATION}) AS "updateEmailChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${SELECTIVE_LEAD_MIGRATION}) AS "selectiveLeadChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${SELECTIVE_CLIENT_MIGRATION}) AS "selectiveClientChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${SELECTIVE_PRACTICE_MIGRATION}) AS "selectivePracticeChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${SELECTIVE_DOCUMENT_MIGRATION}) AS "selectiveDocumentChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${SELECTIVE_PRACTICE_DOCUMENT_MIGRATION}) AS "selectivePracticeDocumentChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${SELECTIVE_COMPANY_MIGRATION}) AS "selectiveCompanyChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${SELECTIVE_PERSON_MIGRATION}) AS "selectivePersonChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${SELECTIVE_LEAD_EDIT_MIGRATION}) AS "selectiveLeadEditChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${TECHNICAL_ASSIGNMENT_MIGRATION}) AS "technicalAssignmentChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${ADMIN_REQUEST_MIGRATION}) AS "adminRequestChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${TECHNICAL_WORK_ITEM_MIGRATION}) AS "technicalWorkItemChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${TECHNICAL_UPLOAD_MIGRATION}) AS "technicalUploadChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${TECHNICAL_ACQUISITION_MIGRATION}) AS "technicalAcquisitionChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${TECHNICAL_PRIVATE_ITEM_MIGRATION}) AS "technicalPrivateItemChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${HISTORICAL_CONTACT_MIGRATION}) AS "historicalContactChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${RECORD_REMINDER_MIGRATION}) AS "recordReminderChecksum",
        (SELECT checksum FROM "_prisma_migrations" WHERE migration_name=${ADMIN_RECORD_MIGRATION}) AS "adminRecordChecksum"`;
    const observed = Date.parse(plan.observedAt), expiry = Date.parse(plan.validUntil);
    if (state.database !== plan.targetDatabase || state.count !== 72 || !state.complete || state.checksum !== MIGRATION_SHA256
      || state.contextChecksum !== CONTEXT_MIGRATION_SHA256
      || state.updatesChecksum !== UPDATES_MIGRATION_SHA256
      || state.videosChecksum !== VIDEOS_MIGRATION_SHA256
      || state.updateEmailChecksum !== UPDATE_EMAIL_MIGRATION_SHA256
      || state.selectiveLeadChecksum !== SELECTIVE_LEAD_MIGRATION_SHA256
      || state.selectiveClientChecksum !== SELECTIVE_CLIENT_MIGRATION_SHA256
      || state.selectivePracticeChecksum !== SELECTIVE_PRACTICE_MIGRATION_SHA256
      || state.selectiveDocumentChecksum !== SELECTIVE_DOCUMENT_MIGRATION_SHA256
      || state.selectivePracticeDocumentChecksum !== SELECTIVE_PRACTICE_DOCUMENT_MIGRATION_SHA256
      || state.selectiveCompanyChecksum !== SELECTIVE_COMPANY_MIGRATION_SHA256
      || state.selectivePersonChecksum !== SELECTIVE_PERSON_MIGRATION_SHA256
      || state.selectiveLeadEditChecksum !== SELECTIVE_LEAD_EDIT_MIGRATION_SHA256
      || state.technicalAssignmentChecksum !== TECHNICAL_ASSIGNMENT_MIGRATION_SHA256
      || state.adminRequestChecksum !== ADMIN_REQUEST_MIGRATION_SHA256
      || state.technicalWorkItemChecksum !== TECHNICAL_WORK_ITEM_MIGRATION_SHA256
      || state.technicalUploadChecksum !== TECHNICAL_UPLOAD_MIGRATION_SHA256
      || state.technicalAcquisitionChecksum !== TECHNICAL_ACQUISITION_MIGRATION_SHA256
      || state.technicalPrivateItemChecksum !== TECHNICAL_PRIVATE_ITEM_MIGRATION_SHA256
      || state.historicalContactChecksum !== HISTORICAL_CONTACT_MIGRATION_SHA256
      || state.recordReminderChecksum !== RECORD_REMINDER_MIGRATION_SHA256
      || state.adminRecordChecksum !== ADMIN_RECORD_MIGRATION_SHA256
      || observed > state.now.getTime() || state.now.getTime() - observed > 300_000
      || expiry <= state.now.getTime() || expiry - observed > 31 * 86_400_000) denied();
    // Lock both people before the mailbox, following native admission ordering.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id IN (${plan.userId}, ${plan.responsibleUserId}) ORDER BY id FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "CommunicationMailbox" WHERE id=${plan.mailboxId}::uuid FOR SHARE`;
    const actor = await tx.user.findUnique({ where: { id: plan.userId } });
    const owner = await tx.user.findUnique({ where: { id: plan.responsibleUserId } });
    const box = await tx.communicationMailbox.findUnique({ where: { id: plan.mailboxId } });
    if (!actor?.active || actor.deletedAt || actor.role !== 'admin' || !owner?.active || owner.deletedAt
      || !box || box.revision !== plan.mailboxRevision || box.responsibleUserId !== owner.id
      || box.kind !== 'MAILBOX' || box.canonicalMailboxId || box.address !== 'comunicazioni@finanzaagevolaimpresa.it'
      || box.providerReference !== 'register_it' || box.configurationReference !== 'M4_COMUNICAZIONI_REGISTER_IT'
      || !box.enabled || !box.canSend || !box.canReceive || box.configuredRevision !== box.revision || box.testedRevision !== box.revision) denied();
    const [existing] = await tx.$queryRaw<Array<{ present: boolean }>>`SELECT
      EXISTS(SELECT 1 FROM "OrdinaryEmailAuthority") OR EXISTS(SELECT 1 FROM "OrdinaryEmailChannel") OR
      EXISTS(SELECT 1 FROM "OrdinaryEmailInboundStream") AS present`;
    if (existing.present) denied();
    const channel = { purpose: 'ORDINARY_SMTP' as const, mailboxId: box.id, mailboxRevision: box.revision,
      address: 'comunicazioni@finanzaagevolaimpresa.it' as const, providerReference: 'register_it' as const,
      configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT' as const, channelRevision: 1,
      qualificationReference: 'PENDING_PRIVATE_FINGERPRINT' };
    const smtpReference = ordinaryTransportQualificationReference(channel, key, environment);
    const descriptor: InboundDescriptor = { protocol: 'IMAP_UID', host: 'pop.securemail.pro', port: 993,
      security: 'TLS', minVersion: 'TLSv1.2', rejectUnauthorized: true, folder: 'INBOX',
      generation: plan.generation, authenticationReference: 'DIRECT_EMAIL_TEST_SMTP_PASSWORD' };
    const credential = environment.DIRECT_EMAIL_TEST_SMTP_PASSWORD;
    if (!credential || !/^[\x20-\x7e]{1,4096}$/.test(credential)) denied();
    const binding = { id: plan.streamId, mailboxId: box.id, mailboxRevision: box.revision, revision: 1,
      descriptor, validUntil: new Date(plan.validUntil) };
    const inboundReference = inboundQualificationReference(binding, key, credential);
    const cursor = plan.historyScope === 'NEW_FROM_ACTIVATION' ? String(Number(plan.observedUidNext) - 1) : '0';
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailAuthority" ("id","userId","mailboxId","revision","enabled")
      VALUES ('ordinary-email',${actor.id},${box.id}::uuid,1,true)`;
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailChannel" ("mailboxId","mailboxRevision","revision","qualificationReference","enabled")
      VALUES (${box.id}::uuid,${box.revision},1,${smtpReference},true)`;
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailInboundStream"
      ("id","mailboxId","mailboxRevision","revision","descriptor","descriptorHash","qualificationReference","validUntil","enabled","cursor","cursorVersion")
      VALUES (${plan.streamId}::uuid,${box.id}::uuid,${box.revision},1,${JSON.stringify(descriptor)}::jsonb,
        ${canonicalSha256(descriptor)},${inboundReference},${binding.validUntil},true,${cursor},0)`;
    const evidence = { action: 'activate', evidenceHash: expectedPlanHash, status: 'ENABLED' };
    const audit = await tx.auditLog.create({ data: { actorId: actor.id, entityType: 'OrdinaryEmailAuthority',
      entityId: 'ordinary-email', event: 'ordinary_email_binding_activated', after: evidence } });
    // Read after the native redaction trigger; an unusable receipt aborts all bindings.
    const persisted = await tx.auditLog.findUnique({ where: { id: audit.id }, select: { after: true } });
    const [finalClock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (canonicalSha256(persisted?.after) !== canonicalSha256(evidence)
      || finalClock.now.getTime() - observed > 300_000 || finalClock.now.getTime() >= expiry) denied();
    // Re-read the existing source immediately before commit; credential drift denies.
    if (ordinaryTransportQualificationReference(channel, key, environment) !== smtpReference) denied();
    return { status: 'ACTIVATED' as const, planSha256: expectedPlanHash, streamId: plan.streamId,
      initialCursor: cursor, cursorVersion: 0, historyScope: plan.historyScope, validUntil: plan.validUntil };
  }, { timeout: 30_000 });
}
