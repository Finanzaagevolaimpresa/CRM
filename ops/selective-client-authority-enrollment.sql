-- Operator-only transaction. The separately reviewed release wrapper binds
-- fai.selective_client_binding to the exact approved profile and approval receipt.
-- No route, seed, startup hook or migration calls this file.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $enrollment$
DECLARE
 binding jsonb := current_setting('fai.selective_client_binding',true)::jsonb;
 actor "User"%ROWTYPE;
BEGIN
 IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'SELECTIVE_CLIENT_ENROLLMENT_BINDING_INVALID'; END IF;
 IF NOT (binding ?& ARRAY['database','userId','name','email','approvalSha256','auditId'])
    OR (SELECT count(*) FROM jsonb_object_keys(binding))<>6
    OR EXISTS(SELECT 1 FROM jsonb_each(binding) WHERE jsonb_typeof(value)<>'string' OR btrim(value #>> '{}')='')
    OR binding->>'database' IS DISTINCT FROM current_database()
    OR ((binding->>'approvalSha256') ~ '^[a-f0-9]{64}$') IS NOT TRUE
    OR ((binding->>'auditId') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') IS NOT TRUE
 THEN RAISE EXCEPTION 'SELECTIVE_CLIENT_ENROLLMENT_BINDING_INVALID'; END IF;
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>57
    OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261018140000_selective_lead_read_v1'
      AND checksum='29053ccb2bb289b24f34b18db9181019518e6dd39e83e7fac7dc49a5dbdde5d4'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1)
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261018190000_selective_client_read_v1'
      AND checksum='55cdaf7e5c714d1fc498ce2bf5131dedc1f05bbafdbb61de5d8dde7ffa753299' AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1)
 THEN RAISE EXCEPTION 'SELECTIVE_CLIENT_ENROLLMENT_SCHEMA57_REQUIRED'; END IF;
 PERFORM id FROM "ApplicationKeyVersion" WHERE purpose='PRIVILEGED_STEP_UP' FOR SHARE;
 IF (SELECT count(*) FROM "ApplicationKeyVersion" WHERE purpose='PRIVILEGED_STEP_UP' AND status='ACTIVE'
      AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL AND octet_length("keyDigest")=32)<>1
 THEN RAISE EXCEPTION 'SELECTIVE_CLIENT_ENROLLMENT_KEY_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('FAI_COMMUNICATION_DIRECTORY_V1',0));
 LOCK TABLE "SelectiveClientAuthority" IN EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM "SelectiveClientAuthority") OR EXISTS(SELECT 1 FROM "SelectiveClientGrant")
    OR EXISTS(SELECT 1 FROM "SelectiveClientCommand") OR EXISTS(SELECT 1 FROM "SelectiveClientRevision")
 THEN RAISE EXCEPTION 'SELECTIVE_CLIENT_ENROLLMENT_ALREADY_STARTED'; END IF;
 SELECT * INTO actor FROM "User" WHERE id=binding->>'userId' FOR UPDATE;
 IF NOT FOUND OR actor.role<>'admin' OR NOT actor.active OR actor."deletedAt" IS NOT NULL
    OR actor.name IS DISTINCT FROM binding->>'name' OR actor.email IS DISTINCT FROM binding->>'email'
    OR EXISTS(SELECT 1 FROM "UserPermissionOverride" WHERE "userId"=actor.id
      AND permission IN ('client.read','client.write') AND NOT allowed)
 THEN RAISE EXCEPTION 'SELECTIVE_CLIENT_ENROLLMENT_PROFILE_DENIED'; END IF;
 INSERT INTO "SelectiveClientAuthority" (id,"userId",revision,enabled) VALUES ('client-sharing',actor.id,1,true);
 INSERT INTO "AuditLog" (id,"actorId",event,"entityType","entityId","before","after","createdAt")
 VALUES (binding->>'auditId',actor.id,'selective_client_authority_enrolled','SelectiveClientAuthority','client-sharing',
   '{"version":0}'::jsonb,jsonb_build_object('version',1,'enabled',true,'approvalHash',binding->>'approvalSha256'),clock_timestamp());
END $enrollment$;
COMMIT;
SELECT 'SELECTIVE_CLIENT_ENROLLMENT_COMMITTED';
