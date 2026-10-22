-- Operator-only, separately approved personal enrollment. Not called by a
-- migration, route, seed or startup hook. The reviewed release wrapper binds
-- the exact human approval and profile; no recipient capability is created.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $enrollment$
DECLARE
 binding jsonb := current_setting('fai.selective_lead_edit_binding',true)::jsonb;
 actor "User"%ROWTYPE;
 read_authority "SelectiveLeadAuthority"%ROWTYPE;
BEGIN
 IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'LEAD_EDIT_ENROLLMENT_BINDING_INVALID'; END IF;
 IF NOT (binding ?& ARRAY['database','userId','name','email','approvalSha256','auditId'])
    OR (SELECT count(*) FROM jsonb_object_keys(binding))<>6
    OR EXISTS(SELECT 1 FROM jsonb_each(binding) WHERE jsonb_typeof(value)<>'string' OR btrim(value #>> '{}')='')
    OR binding->>'database' IS DISTINCT FROM current_database()
    OR ((binding->>'approvalSha256') ~ '^[a-f0-9]{64}$') IS NOT TRUE
    OR ((binding->>'auditId') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') IS NOT TRUE
 THEN RAISE EXCEPTION 'LEAD_EDIT_ENROLLMENT_BINDING_INVALID'; END IF;
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>63
    OR EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations"
      WHERE migration_name='20261022110000_selective_lead_edit_v1'
       AND checksum='4534f290bc80f9b41f1c4de1f9df8d88f7402c02c0604797351c07e187c6961c'
       AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1)
    OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations"
      WHERE migration_name='20261021220000_selective_client_person_fields_v1'
       AND checksum='984a2706bf907492c01aac9ae04889471918244ebeb816564854c9ccc29b0603'
       AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1)
 THEN RAISE EXCEPTION 'LEAD_EDIT_ENROLLMENT_SCHEMA63_REQUIRED'; END IF;
 -- Same order as the native command: key, directory, identity, read authority,
 -- edit authority, user. Enrollment never mutates an existing authority.
 PERFORM id FROM "ApplicationKeyVersion" WHERE purpose='PRIVILEGED_STEP_UP' FOR SHARE;
 IF (SELECT count(*) FROM "ApplicationKeyVersion" WHERE purpose='PRIVILEGED_STEP_UP' AND status='ACTIVE'
      AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL AND octet_length("keyDigest")=32)<>1
 THEN RAISE EXCEPTION 'LEAD_EDIT_ENROLLMENT_KEY_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('FAI_COMMUNICATION_DIRECTORY_V1',0));
 PERFORM pg_advisory_xact_lock(hashtext('FAI_LEAD_IDENTITY_WRITE_V1'));
 SELECT * INTO read_authority FROM "SelectiveLeadAuthority" WHERE id='lead-sharing' FOR SHARE;
 IF NOT FOUND OR NOT read_authority.enabled OR read_authority.revision<1
    OR read_authority."userId" IS DISTINCT FROM binding->>'userId'
 THEN RAISE EXCEPTION 'LEAD_EDIT_ENROLLMENT_READ_AUTHORITY_REQUIRED'; END IF;
 LOCK TABLE "SelectiveLeadEditAuthority" IN EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM "SelectiveLeadEditAuthority") OR EXISTS(SELECT 1 FROM "SelectiveLeadEditGrant")
    OR EXISTS(SELECT 1 FROM "SelectiveLeadEditDecision") OR EXISTS(SELECT 1 FROM "SelectiveLeadEditRevision")
    OR EXISTS(SELECT 1 FROM "SelectiveLeadEditCommand")
 THEN RAISE EXCEPTION 'LEAD_EDIT_ENROLLMENT_ALREADY_STARTED'; END IF;
 SELECT * INTO actor FROM "User" WHERE id=binding->>'userId' FOR UPDATE;
 IF NOT FOUND OR actor.role<>'admin' OR NOT actor.active OR actor."deletedAt" IS NOT NULL
    OR actor.name IS DISTINCT FROM binding->>'name' OR actor.email IS DISTINCT FROM binding->>'email'
    OR EXISTS(SELECT 1 FROM "UserPermissionOverride" WHERE "userId"=actor.id
      AND permission IN ('lead.read','lead.write') AND NOT allowed)
 THEN RAISE EXCEPTION 'LEAD_EDIT_ENROLLMENT_PROFILE_DENIED'; END IF;
 INSERT INTO "SelectiveLeadEditAuthority" (id,"userId",revision,enabled) VALUES ('lead-edit',actor.id,1,true);
 INSERT INTO "AuditLog" (id,"actorId",event,"entityType","entityId","before","after","createdAt")
 VALUES (binding->>'auditId',actor.id,'selective_lead_edit_authority_enrolled','SelectiveLeadEditAuthority','lead-edit',
   '{"version":0}'::jsonb,jsonb_build_object('version',1,'enabled',true,'approvalHash',binding->>'approvalSha256'),clock_timestamp());
END $enrollment$;
COMMIT;
SELECT 'LEAD_EDIT_ENROLLMENT_COMMITTED';
