-- Operator-only, separately approved personal enrollment. Not called by a
-- migration, route, seed or startup hook. The reviewed release wrapper binds
-- the exact human approval and profile; no recipient capability is created.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $enrollment$
DECLARE
 binding jsonb := current_setting('fai.technical_assignment_binding',true)::jsonb;
 actor "User"%ROWTYPE;
BEGIN
 IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'TECHNICAL_ENROLLMENT_BINDING_INVALID'; END IF;
 IF NOT (binding ?& ARRAY['database','userId','name','email','approvalSha256','auditId'])
    OR (SELECT count(*) FROM jsonb_object_keys(binding))<>6
    OR EXISTS(SELECT 1 FROM jsonb_each(binding) WHERE jsonb_typeof(value)<>'string' OR btrim(value #>> '{}')='')
    OR binding->>'database' IS DISTINCT FROM current_database()
    OR ((binding->>'approvalSha256') ~ '^[a-f0-9]{64}$') IS NOT TRUE
    OR ((binding->>'auditId') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') IS NOT TRUE
 THEN RAISE EXCEPTION 'TECHNICAL_ENROLLMENT_BINDING_INVALID'; END IF;
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>64
    OR EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations"
      WHERE migration_name='20261022200000_technical_assignments_v1'
       AND checksum='9b3a7b1cab3cd97df9c110bff4b7590f7bee8acaabe7e985e3bfbfba3f5b7583'
       AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1)
    OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations"
      WHERE migration_name='20261022110000_selective_lead_edit_v1'
       AND checksum='4534f290bc80f9b41f1c4de1f9df8d88f7402c02c0604797351c07e187c6961c'
       AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1)
 THEN RAISE EXCEPTION 'TECHNICAL_ENROLLMENT_SCHEMA64_REQUIRED'; END IF;
 -- Same order as the native command: key, directory, authority, user. Enrollment never mutates an existing authority.
 PERFORM id FROM "ApplicationKeyVersion" WHERE purpose='PRIVILEGED_STEP_UP' FOR SHARE;
 IF (SELECT count(*) FROM "ApplicationKeyVersion" WHERE purpose='PRIVILEGED_STEP_UP' AND status='ACTIVE'
      AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL AND octet_length("keyDigest")=32)<>1
 THEN RAISE EXCEPTION 'TECHNICAL_ENROLLMENT_KEY_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('FAI_COMMUNICATION_DIRECTORY_V1',0));
 LOCK TABLE "TechnicalAssignmentAuthority" IN EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM "TechnicalAssignmentAuthority") OR EXISTS(SELECT 1 FROM "TechnicalAssignment")
    OR EXISTS(SELECT 1 FROM "TechnicalAssignmentDecision") OR EXISTS(SELECT 1 FROM "TechnicalAssignmentRevision")
    OR EXISTS(SELECT 1 FROM "TechnicalWorkCommand")
 THEN RAISE EXCEPTION 'TECHNICAL_ENROLLMENT_ALREADY_STARTED'; END IF;
 SELECT * INTO actor FROM "User" WHERE id=binding->>'userId' FOR UPDATE;
 IF NOT FOUND OR actor.role<>'admin' OR NOT actor.active OR actor."deletedAt" IS NOT NULL
    OR actor.name IS DISTINCT FROM binding->>'name' OR actor.email IS DISTINCT FROM binding->>'email'
    OR EXISTS(SELECT 1 FROM "UserPermissionOverride" WHERE "userId"=actor.id
      AND permission IN ('project.read','project.write','technical.read','technical.assign') AND NOT allowed)
 THEN RAISE EXCEPTION 'TECHNICAL_ENROLLMENT_PROFILE_DENIED'; END IF;
 INSERT INTO "TechnicalAssignmentAuthority" (id,"userId",revision,enabled) VALUES ('technical-assignment',actor.id,1,true);
 INSERT INTO "AuditLog" (id,"actorId",event,"entityType","entityId","before","after","createdAt")
 VALUES (binding->>'auditId',actor.id,'technical_assignment_authority_enrolled','TechnicalAssignmentAuthority','technical-assignment',
   '{"version":0}'::jsonb,jsonb_build_object('version',1,'enabled',true,'approvalHash',binding->>'approvalSha256'),clock_timestamp());
END $enrollment$;
COMMIT;
SELECT 'TECHNICAL_ENROLLMENT_COMMITTED';
