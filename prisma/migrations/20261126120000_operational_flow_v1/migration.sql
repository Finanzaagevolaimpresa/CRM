BEGIN;

-- CreateTable
CREATE TABLE "InternalNotificationRead" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "InternalNotificationRead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalCalendar" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "availability" JSONB NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'LOCAL',
    "googleCalendarId" TEXT,
    "credentialReference" TEXT,
    "lastTestAt" TIMESTAMP(3),
    "lastTestStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadAppointment" (
    "generation" INTEGER NOT NULL DEFAULT 1,
    "id" UUID NOT NULL,
    "leadId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BOOKED',
    "syncState" TEXT NOT NULL DEFAULT 'LOCAL',
    "externalEventId" TEXT,
    "externalEtag" TEXT,
    "syncError" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleCalendarOAuthState" (
    "stateHash" CHAR(64) NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "verifierCiphertext" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleCalendarOAuthState_pkey" PRIMARY KEY ("stateHash")
);

-- CreateTable
CREATE TABLE "GoogleCalendarCredential" (
    "userId" TEXT NOT NULL,
    "googleSubject" TEXT NOT NULL,
    "accessTokenCiphertext" TEXT NOT NULL,
    "refreshTokenCiphertext" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleCalendarCredential_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "OperationalDocument" (
    "id" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "leadId" TEXT,
    "clientId" TEXT,
    "contractId" TEXT,
    "sourceDocumentId" UUID,
    "templateCommandId" UUID NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "sourceHash" CHAR(64) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "dedupKey" CHAR(64),
    "snapshot" JSONB NOT NULL,
    "content" TEXT NOT NULL,
    "dueDate" VARCHAR(10),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalDocumentDecision" (
    "commandId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalDocumentDecision_pkey" PRIMARY KEY ("commandId")
);

-- CreateTable
CREATE TABLE "WorkflowEmailTemplate" (
    "id" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "purpose" VARCHAR(40) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "authorizationReference" VARCHAR(200),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowEmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowAutomation" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "event" VARCHAR(40) NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "delayMinutes" INTEGER NOT NULL,
    "configuration" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkflowAutomation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowAutomationTest" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "automationVersion" INTEGER NOT NULL,
    "result" JSONB NOT NULL,
    "performedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowAutomationTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowEnrollment" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "automationVersion" INTEGER NOT NULL,
    "eventKey" VARCHAR(160) NOT NULL,
    "leadId" TEXT NOT NULL,
    "sourceReceiptId" UUID,
    "sourceHash" CHAR(64) NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "state" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "snapshot" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkflowEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowExecution" (
    "recipientUserId" TEXT,
    "id" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "step" VARCHAR(20) NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "requestKey" CHAR(64) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "templateSnapshot" JSONB NOT NULL,
    "receipt" JSONB,
    "stopReason" VARCHAR(120),
    "history" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkflowExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowNewsletterRun" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "automationVersion" INTEGER NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "state" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkflowNewsletterRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowNewsletterRecipient" (
    "id" UUID NOT NULL,
    "nativeMessageId" UUID,
    "nativeRevision" INTEGER,
    "nativeSnapshotHash" CHAR(64),
    "runId" UUID NOT NULL,
    "leadId" TEXT NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "requestKey" CHAR(64) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "snapshot" JSONB NOT NULL,
    "policySnapshot" JSONB,
    "receipt" JSONB,
    "history" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkflowNewsletterRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadAssignmentProposal" (
    "id" UUID NOT NULL,
    "leadId" TEXT NOT NULL,
    "proposedById" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "inboxVersion" INTEGER NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(500) NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadAssignmentProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InternalNotificationRead_recipientId_readAt_idx" ON "InternalNotificationRead"("recipientId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "InternalNotificationRead_recipientId_notificationId_key" ON "InternalNotificationRead"("recipientId", "notificationId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalCalendar_userId_key" ON "PersonalCalendar"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadAppointment_leadId_key" ON "LeadAppointment"("leadId");

-- CreateIndex
CREATE INDEX "LeadAppointment_calendarId_status_startsAt_idx" ON "LeadAppointment"("calendarId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "GoogleCalendarOAuthState_userId_expiresAt_idx" ON "GoogleCalendarOAuthState"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalDocument_dedupKey_key" ON "OperationalDocument"("dedupKey");

-- CreateIndex
CREATE INDEX "OperationalDocument_leadId_createdAt_idx" ON "OperationalDocument"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "OperationalDocument_clientId_createdAt_idx" ON "OperationalDocument"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalDocumentDecision_documentId_key" ON "OperationalDocumentDecision"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowEmailTemplate_familyId_version_key" ON "WorkflowEmailTemplate"("familyId", "version");

-- CreateIndex
CREATE INDEX "WorkflowAutomationTest_automationId_createdAt_idx" ON "WorkflowAutomationTest"("automationId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowEnrollment_leadId_createdAt_idx" ON "WorkflowEnrollment"("leadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowEnrollment_automationId_eventKey_key" ON "WorkflowEnrollment"("automationId", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowExecution_requestKey_key" ON "WorkflowExecution"("requestKey");

-- CreateIndex
CREATE INDEX "WorkflowExecution_state_dueAt_idx" ON "WorkflowExecution"("state", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowExecution_enrollmentId_step_key" ON "WorkflowExecution"("enrollmentId", "step");

-- CreateIndex
CREATE INDEX "WorkflowNewsletterRun_automationId_createdAt_idx" ON "WorkflowNewsletterRun"("automationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowNewsletterRecipient_requestKey_key" ON "WorkflowNewsletterRecipient"("requestKey");

-- CreateIndex
CREATE INDEX "WorkflowNewsletterRecipient_state_runId_idx" ON "WorkflowNewsletterRecipient"("state", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowNewsletterRecipient_runId_leadId_key" ON "WorkflowNewsletterRecipient"("runId", "leadId");

-- CreateIndex
CREATE INDEX "LeadAssignmentProposal_leadId_createdAt_idx" ON "LeadAssignmentProposal"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadAssignmentProposal_state_createdAt_idx" ON "LeadAssignmentProposal"("state", "createdAt");

-- AddForeignKey
ALTER TABLE "InternalNotificationRead" ADD CONSTRAINT "InternalNotificationRead_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalCalendar" ADD CONSTRAINT "PersonalCalendar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAppointment" ADD CONSTRAINT "LeadAppointment_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeadAppointment" ADD CONSTRAINT "LeadAppointment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeadAppointment" ADD CONSTRAINT "LeadAppointment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAppointment" ADD CONSTRAINT "LeadAppointment_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "PersonalCalendar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleCalendarOAuthState" ADD CONSTRAINT "GoogleCalendarOAuthState_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InternalSession"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GoogleCalendarOAuthState" ADD CONSTRAINT "GoogleCalendarOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleCalendarCredential" ADD CONSTRAINT "GoogleCalendarCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalDocument" ADD CONSTRAINT "OperationalDocument_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationalDocument" ADD CONSTRAINT "OperationalDocument_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InternalSession"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationalDocument" ADD CONSTRAINT "OperationalDocument_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationalDocument" ADD CONSTRAINT "OperationalDocument_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationalDocument" ADD CONSTRAINT "OperationalDocument_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationalDocument" ADD CONSTRAINT "OperationalDocument_templateCommandId_fkey" FOREIGN KEY ("templateCommandId") REFERENCES "AdminRecordRevision"("commandId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationalDocument" ADD CONSTRAINT "OperationalDocument_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "OperationalDocument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationalDocumentDecision" ADD CONSTRAINT "OperationalDocumentDecision_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "OperationalDocument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationalDocumentDecision" ADD CONSTRAINT "OperationalDocumentDecision_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationalDocumentDecision" ADD CONSTRAINT "OperationalDocumentDecision_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InternalSession"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowEmailTemplate" ADD CONSTRAINT "WorkflowEmailTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowAutomation" ADD CONSTRAINT "WorkflowAutomation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowAutomationTest" ADD CONSTRAINT "WorkflowAutomationTest_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowAutomationTest" ADD CONSTRAINT "WorkflowAutomationTest_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "WorkflowAutomation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowEnrollment" ADD CONSTRAINT "WorkflowEnrollment_sourceReceiptId_fkey" FOREIGN KEY ("sourceReceiptId") REFERENCES "SecureLeadGatewayReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowEnrollment" ADD CONSTRAINT "WorkflowEnrollment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowEnrollment" ADD CONSTRAINT "WorkflowEnrollment_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "WorkflowAutomation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowEnrollment" ADD CONSTRAINT "WorkflowEnrollment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowExecution" ADD CONSTRAINT "WorkflowExecution_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "WorkflowEnrollment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowNewsletterRun" ADD CONSTRAINT "WorkflowNewsletterRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "WorkflowAutomation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowNewsletterRun" ADD CONSTRAINT "WorkflowNewsletterRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowNewsletterRecipient" ADD CONSTRAINT "WorkflowNewsletterRecipient_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowNewsletterRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowNewsletterRecipient" ADD CONSTRAINT "WorkflowNewsletterRecipient_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeadAssignmentProposal" ADD CONSTRAINT "LeadAssignmentProposal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeadAssignmentProposal" ADD CONSTRAINT "LeadAssignmentProposal_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeadAssignmentProposal" ADD CONSTRAINT "LeadAssignmentProposal_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeadAssignmentProposal" ADD CONSTRAINT "LeadAssignmentProposal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Operational evidence is immutable; a new document is always a new snapshot.
CREATE FUNCTION fai_operational_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'OPERATIONAL_EVIDENCE_IMMUTABLE'; END;
$$;
CREATE TRIGGER operational_document_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "OperationalDocument"
FOR EACH STATEMENT EXECUTE FUNCTION fai_operational_evidence_immutable();
CREATE TRIGGER operational_document_decision_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "OperationalDocumentDecision"
FOR EACH STATEMENT EXECUTE FUNCTION fai_operational_evidence_immutable();
CREATE TRIGGER workflow_email_template_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "WorkflowEmailTemplate"
FOR EACH STATEMENT EXECUTE FUNCTION fai_operational_evidence_immutable();
CREATE TRIGGER workflow_test_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "WorkflowAutomationTest"
FOR EACH STATEMENT EXECUTE FUNCTION fai_operational_evidence_immutable();
ALTER TABLE "OperationalDocument" ADD CONSTRAINT operational_document_kind CHECK (kind IN ('CONTRACT','QUOTE','PROPOSAL','PROFORMA'));
ALTER TABLE "LeadAppointment" ADD CONSTRAINT lead_appointment_window CHECK ("endsAt" > "startsAt");
ALTER TABLE "LeadAppointment" ADD CONSTRAINT lead_appointment_status CHECK (status IN ('BOOKED','CANCELLED','COMPLETED'));
ALTER TABLE "LeadAppointment" ADD CONSTRAINT lead_appointment_generation CHECK (generation > 0 AND version > 0);
ALTER TABLE "LeadAssignmentProposal" ADD CONSTRAINT lead_assignment_proposal_state CHECK (state IN ('PENDING','CONFIRMED','SUPERSEDED'));
CREATE UNIQUE INDEX lead_assignment_proposal_pending ON "LeadAssignmentProposal" ("leadId") WHERE state='PENDING';

ALTER TABLE "WorkflowEmailTemplate" ADD CONSTRAINT workflow_template_valid CHECK (version > 0 AND state IN ('DRAFT','PUBLISHED'));
ALTER TABLE "WorkflowAutomation" ADD CONSTRAINT workflow_automation_valid CHECK (version > 0 AND "delayMinutes" BETWEEN 1 AND 43200 AND state IN ('DRAFT','TEST_READY','ACTIVE'));
ALTER TABLE "WorkflowExecution" ADD CONSTRAINT workflow_execution_valid CHECK ("attemptCount" >= 0 AND jsonb_typeof(history) = 'array');
ALTER TABLE "WorkflowNewsletterRecipient" ADD CONSTRAINT workflow_newsletter_recipient_valid CHECK ("attemptCount" >= 0 AND jsonb_typeof(history) = 'array');
CREATE UNIQUE INDEX "WorkflowNewsletterRecipient_nativeMessageId_key" ON "WorkflowNewsletterRecipient"("nativeMessageId");
ALTER TABLE "WorkflowNewsletterRecipient" ADD CONSTRAINT "WorkflowNewsletterRecipient_nativeMessageId_fkey" FOREIGN KEY ("nativeMessageId") REFERENCES "ApprovedCommunication"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "WorkflowNewsletterRecipient" ADD CONSTRAINT workflow_newsletter_native_binding CHECK (
  ("nativeMessageId" IS NULL AND "nativeRevision" IS NULL AND "nativeSnapshotHash" IS NULL AND state <> 'PREPARED') OR
  (num_nulls("nativeMessageId","nativeRevision","nativeSnapshotHash")=0 AND "nativeMessageId" = id AND "nativeRevision" > 0 AND "nativeSnapshotHash" ~ '^[a-f0-9]{64}$'));
CREATE FUNCTION fai_workflow_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE immutable text[];
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'WORKFLOW_HISTORY_IMMUTABLE'; END IF;
  immutable := CASE TG_TABLE_NAME
    WHEN 'WorkflowEnrollment' THEN ARRAY['id','automationId','automationVersion','eventKey','leadId','sourceReceiptId','sourceHash','synthetic','snapshot','createdById','createdAt']
    WHEN 'WorkflowExecution' THEN ARRAY['id','enrollmentId','step','dueAt','requestKey','templateSnapshot','recipientUserId','createdAt']
    WHEN 'WorkflowNewsletterRun' THEN ARRAY['id','automationId','automationVersion','synthetic','scheduledAt','snapshot','createdById','createdAt']
    WHEN 'WorkflowNewsletterRecipient' THEN ARRAY['id','runId','leadId','requestKey','snapshot','createdAt']
  END;
  IF (SELECT jsonb_object_agg(k,to_jsonb(NEW)->k) FROM unnest(immutable) k) IS DISTINCT FROM
     (SELECT jsonb_object_agg(k,to_jsonb(OLD)->k) FROM unnest(immutable) k) THEN
    RAISE EXCEPTION 'WORKFLOW_SOURCE_IMMUTABLE';
  END IF;
  IF TG_TABLE_NAME IN ('WorkflowExecution','WorkflowNewsletterRecipient') THEN
    IF NEW."attemptCount" < OLD."attemptCount" OR NEW."attemptCount" > OLD."attemptCount" + 1
      OR jsonb_typeof(NEW.history) <> 'array' OR jsonb_array_length(NEW.history) < jsonb_array_length(OLD.history)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.history) WITH ORDINALITY h(value,n)
        WHERE NEW.history->(h.n::int-1) IS DISTINCT FROM h.value)
      OR (OLD.state='SENT' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
      RAISE EXCEPTION 'WORKFLOW_HISTORY_IMMUTABLE';
    END IF;
  END IF;
  IF TG_TABLE_NAME='WorkflowNewsletterRecipient' THEN
    IF OLD."nativeMessageId" IS NOT NULL AND
      (NEW."nativeMessageId",NEW."nativeRevision",NEW."nativeSnapshotHash") IS DISTINCT FROM
      (OLD."nativeMessageId",OLD."nativeRevision",OLD."nativeSnapshotHash") THEN
      RAISE EXCEPTION 'WORKFLOW_NEWSLETTER_MESSAGE_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_enrollment_guard BEFORE UPDATE OR DELETE ON "WorkflowEnrollment" FOR EACH ROW EXECUTE FUNCTION fai_workflow_history_guard();
CREATE TRIGGER workflow_execution_guard BEFORE UPDATE OR DELETE ON "WorkflowExecution" FOR EACH ROW EXECUTE FUNCTION fai_workflow_history_guard();
CREATE TRIGGER workflow_newsletter_run_guard BEFORE UPDATE OR DELETE ON "WorkflowNewsletterRun" FOR EACH ROW EXECUTE FUNCTION fai_workflow_history_guard();
CREATE TRIGGER workflow_newsletter_recipient_guard BEFORE UPDATE OR DELETE ON "WorkflowNewsletterRecipient" FOR EACH ROW EXECUTE FUNCTION fai_workflow_history_guard();
CREATE FUNCTION fai_workflow_newsletter_message_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."nativeMessageId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "WorkflowNewsletterRun" r JOIN "ApprovedCommunication" m ON m.id=NEW."nativeMessageId"
      JOIN "CommunicationVersion" v ON v."messageId"=m.id AND v.revision=NEW."nativeRevision"
    WHERE r.id=NEW."runId" AND NOT r.synthetic AND m."leadId"=NEW."leadId" AND v."snapshotHash"=NEW."nativeSnapshotHash"
  ) THEN RAISE EXCEPTION 'WORKFLOW_NEWSLETTER_MESSAGE_BINDING_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_newsletter_message_binding BEFORE INSERT OR UPDATE ON "WorkflowNewsletterRecipient"
  FOR EACH ROW EXECUTE FUNCTION fai_workflow_newsletter_message_binding();
CREATE TRIGGER workflow_enrollment_no_truncate BEFORE TRUNCATE ON "WorkflowEnrollment" FOR EACH STATEMENT EXECUTE FUNCTION fai_operational_evidence_immutable();
CREATE TRIGGER workflow_execution_no_truncate BEFORE TRUNCATE ON "WorkflowExecution" FOR EACH STATEMENT EXECUTE FUNCTION fai_operational_evidence_immutable();
CREATE TRIGGER workflow_newsletter_run_no_truncate BEFORE TRUNCATE ON "WorkflowNewsletterRun" FOR EACH STATEMENT EXECUTE FUNCTION fai_operational_evidence_immutable();
CREATE TRIGGER workflow_newsletter_recipient_no_truncate BEFORE TRUNCATE ON "WorkflowNewsletterRecipient" FOR EACH STATEMENT EXECUTE FUNCTION fai_operational_evidence_immutable();

-- Promote the existing R13 empty schema only; no policy, key or epoch is activated.

CREATE TABLE "MarketingPreferenceEpoch" (
  "singleton" BOOLEAN PRIMARY KEY DEFAULT true CHECK ("singleton" = true),
  "epoch" UUID NOT NULL,
  "reconciled" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE "MarketingPreferenceSubject" (
  "contactKey" TEXT PRIMARY KEY CHECK ("contactKey" ~ '^r13-email-v1:[0-9a-f]{64}$'),
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "quarantined" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE "MarketingPreferenceEvent" (
  "contactKey" TEXT NOT NULL REFERENCES "MarketingPreferenceSubject"("contactKey") ON UPDATE RESTRICT ON DELETE RESTRICT,
  "eventId" UUID NOT NULL,
  "payload" JSONB NOT NULL,
  "eventHash" TEXT NOT NULL CHECK ("eventHash" ~ '^[0-9a-f]{64}$'),
  "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "receiptId" UUID GENERATED ALWAYS AS (("payload"->>'receiptId')::UUID) STORED UNIQUE
    REFERENCES "PrivacyEvidenceReceipt"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  "noticeVersionId" UUID GENERATED ALWAYS AS (("payload"->>'noticeVersionId')::UUID) STORED
    REFERENCES "PrivacyNoticeVersion"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  PRIMARY KEY ("contactKey", "eventId"),
  CHECK (jsonb_typeof("payload") = 'object'),
  CHECK ("payload" ?& ARRAY['eventId','contactKey','kind','occurredAt','source','operatorRef','outcome',
    'receiptId','noticeVersionId','noticeHash','canonicalNoticeText']),
  CHECK ("payload" - ARRAY['eventId','contactKey','kind','occurredAt','source','operatorRef','outcome',
    'receiptId','noticeVersionId','noticeHash','canonicalNoticeText'] = '{}'::JSONB)
);

CREATE FUNCTION "marketing_preference_event_validate_r13"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  data JSONB := NEW."payload";
  kind TEXT := data->>'kind';
  receipt "PrivacyEvidenceReceipt"%ROWTYPE;
  notice "PrivacyNoticeVersion"%ROWTYPE;
  occurred TIMESTAMPTZ;
BEGIN
  NEW."recordedAt" := date_trunc('milliseconds', clock_timestamp());
  IF data->>'contactKey' IS DISTINCT FROM NEW."contactKey"
    OR data->>'eventId' IS DISTINCT FROM NEW."eventId"::TEXT
    OR data->>'outcome' IS DISTINCT FROM (CASE WHEN kind = 'GRANTED' THEN 'CONSENT_RECORDED' ELSE 'PROMOTIONAL_BLOCKED' END)
    OR kind IS NULL OR kind NOT IN ('GRANTED','DENIED','WITHDRAWN','SUPPRESSED','PURPOSE_CLOSED') THEN
    RAISE EXCEPTION 'MARKETING_EVENT_INVALID';
  END IF;
  occurred := (data->>'occurredAt')::TIMESTAMPTZ;
  IF occurred IS NULL OR occurred > clock_timestamp()
    OR to_char(occurred AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM data->>'occurredAt' THEN
    RAISE EXCEPTION 'MARKETING_EVENT_TIME_INVALID';
  END IF;
  IF NEW."eventHash" IS DISTINCT FROM encode(sha256(convert_to("canonicalize_ai_execution_jsonb_v2"(
      jsonb_build_object('domain', 'fai.marketing-preference.r13.v1') || data), 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'MARKETING_EVENT_HASH_INVALID';
  END IF;
  IF kind IN ('GRANTED','DENIED') THEN
    SELECT * INTO receipt FROM "PrivacyEvidenceReceipt" WHERE "id" = (data->>'receiptId')::UUID FOR SHARE;
    IF NOT FOUND OR receipt."businessInboxEventId" IS NULL OR receipt."decision"::TEXT IS DISTINCT FROM kind
      OR receipt."purposeCode" <> 'DIRECT_MARKETING' OR receipt."legalBasisCode" <> 'CONSENT'
      OR receipt."evidenceKind"::TEXT <> 'CONSENT' OR receipt."sourceSubmittedAt" IS DISTINCT FROM occurred
      OR receipt."noticeVersionId"::TEXT IS DISTINCT FROM data->>'noticeVersionId' THEN
      RAISE EXCEPTION 'MARKETING_RECEIPT_BINDING_INVALID';
    END IF;
    SELECT * INTO notice FROM "PrivacyNoticeVersion" WHERE "id" = receipt."noticeVersionId" FOR SHARE;
    IF NOT FOUND OR data->>'source' IS DISTINCT FROM 'Q05_RECEIPT' OR data->'operatorRef' <> 'null'::JSONB
      OR jsonb_typeof(data->'canonicalNoticeText') IS DISTINCT FROM 'string'
      OR length(data->>'canonicalNoticeText') NOT BETWEEN 1 AND 200000
      OR notice."contentHash" IS DISTINCT FROM data->>'noticeHash'
      OR notice."contentHash" IS DISTINCT FROM encode(sha256(convert_to(data->>'canonicalNoticeText', 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'MARKETING_NOTICE_BINDING_INVALID';
    END IF;
  ELSE
    IF data->'receiptId' <> 'null'::JSONB OR data->'noticeVersionId' <> 'null'::JSONB
      OR data->'canonicalNoticeText' <> 'null'::JSONB OR data->'noticeHash' <> 'null'::JSONB
      OR ((
        (kind = 'SUPPRESSED' AND data->>'source' = 'PUBLIC_REQUEST' AND data->'operatorRef' = 'null'::JSONB)
        OR (kind = 'WITHDRAWN' AND data->>'source' = 'AUTHORIZED_OPERATOR'
          AND coalesce(data->>'operatorRef','') ~ '^[a-zA-Z0-9_-]{1,120}$')
        OR (kind = 'PURPOSE_CLOSED' AND data->>'source' = 'PURPOSE_POLICY'
          AND coalesce(data->>'operatorRef','') ~ '^[a-zA-Z0-9_-]{1,120}$')
      ) IS NOT TRUE) THEN
      RAISE EXCEPTION 'MARKETING_BLOCK_INVALID';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "marketing_preference_event_advance_r13"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "MarketingPreferenceSubject" SET "revision" = "revision" + 1 WHERE "contactKey" = NEW."contactKey";
  RETURN NEW;
END;
$$;

CREATE FUNCTION "marketing_preference_subject_guard_r13"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 0 OR NEW."quarantined" THEN RAISE EXCEPTION 'MARKETING_INITIAL_STATE_INVALID'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'MARKETING_SUBJECT_REMOVAL_DENIED'; END IF;
  IF OLD."contactKey" IS DISTINCT FROM NEW."contactKey" OR (OLD."quarantined" AND NOT NEW."quarantined")
    OR (OLD."revision" IS DISTINCT FROM NEW."revision" AND (pg_trigger_depth() < 2 OR NEW."revision" <> OLD."revision" + 1)) THEN
    RAISE EXCEPTION 'MARKETING_SUBJECT_MUTATION_DENIED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MarketingPreferenceSubject_guard_r13" BEFORE INSERT OR UPDATE OR DELETE ON "MarketingPreferenceSubject"
  FOR EACH ROW EXECUTE FUNCTION "marketing_preference_subject_guard_r13"();
CREATE TRIGGER "MarketingPreferenceEvent_validate_r13" BEFORE INSERT ON "MarketingPreferenceEvent"
  FOR EACH ROW EXECUTE FUNCTION "marketing_preference_event_validate_r13"();
CREATE TRIGGER "MarketingPreferenceEvent_advance_r13" AFTER INSERT ON "MarketingPreferenceEvent"
  FOR EACH ROW EXECUTE FUNCTION "marketing_preference_event_advance_r13"();
CREATE TRIGGER "MarketingPreferenceEvent_append_only_r13" BEFORE UPDATE OR DELETE ON "MarketingPreferenceEvent"
  FOR EACH ROW EXECUTE FUNCTION "privacy_evidence_receipt_append_only_v1"();
CREATE TRIGGER "MarketingPreferenceEvent_no_truncate_r13" BEFORE TRUNCATE ON "MarketingPreferenceEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "privacy_registry_deny_truncate_v1"();
CREATE TRIGGER "MarketingPreferenceSubject_no_truncate_r13" BEFORE TRUNCATE ON "MarketingPreferenceSubject"
  FOR EACH STATEMENT EXECUTE FUNCTION "privacy_registry_deny_truncate_v1"();


ALTER TABLE "WorkflowExecution" ADD CONSTRAINT "WorkflowExecution_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
COMMIT;
