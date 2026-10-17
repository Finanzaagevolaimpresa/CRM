-- Private video library preparation. Requires the exact schema53 prefix.
-- No video, publication, audience, user, provider or grant is seeded.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>53
  OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations"
    WHERE migration_name='20261017200000_record_update_notifications_v1'
    AND checksum='11df35b3e90d69aa535104fcc8b15eb32ed218691c40dd85409cc51edf2a3ef0'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname=current_schema() AND tablename IN ('VideoAsset','VideoEntry','VideoRevision','VideoCommand')) THEN
  RAISE EXCEPTION 'VIDEO_MIGRATION54_BASE_REQUIRED';
 END IF;
END $$;

CREATE TABLE "VideoAsset" (
 "id" UUID PRIMARY KEY,
 "ownerId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "ownerEpoch" INTEGER NOT NULL CHECK ("ownerEpoch">0),
 "fileName" VARCHAR(180) NOT NULL CHECK (length("fileName")>0),
 "mimeType" VARCHAR(20) NOT NULL CHECK ("mimeType" IN ('video/mp4','video/webm')),
 "sizeBytes" INTEGER NOT NULL CHECK ("sizeBytes" BETWEEN 12 AND 20971520),
 "sha256" CHAR(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
 "state" VARCHAR(12) NOT NULL DEFAULT 'RESERVED' CHECK ("state" IN ('RESERVED','READY')),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(), "readyAt" TIMESTAMPTZ(3),
 CHECK (("state"='RESERVED' AND "readyAt" IS NULL) OR ("state"='READY' AND "readyAt" IS NOT NULL))
);
CREATE INDEX "VideoAsset_ownerId_createdAt_idx" ON "VideoAsset"("ownerId","createdAt");
CREATE TABLE "VideoEntry" (
 "id" UUID PRIMARY KEY, "fileId" UUID NOT NULL REFERENCES "VideoAsset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version">0),
 "state" VARCHAR(12) NOT NULL DEFAULT 'DRAFT' CHECK ("state" IN ('DRAFT','PUBLISHED','ARCHIVED')),
 "title" VARCHAR(160) NOT NULL CHECK (length(btrim("title"))>0), "description" VARCHAR(3000) NOT NULL,
 "category" VARCHAR(80) NOT NULL, "position" INTEGER NOT NULL DEFAULT 0 CHECK ("position" BETWEEN 0 AND 10000),
 "selection" JSONB NOT NULL CHECK (jsonb_typeof("selection")='object'),
 "audience" JSONB NOT NULL CHECK (jsonb_typeof("audience")='array' AND jsonb_array_length("audience")<=100),
 "directoryBinding" CHAR(64) NOT NULL CHECK ("directoryBinding" ~ '^[a-f0-9]{64}$'),
 "publishedById" TEXT REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "publisherEpoch" INTEGER CHECK ("publisherEpoch">0),
 "downloadAllowed" BOOLEAN NOT NULL DEFAULT false, "expiresAt" TIMESTAMPTZ(3),
 "createdById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(), "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CHECK (("publishedById" IS NULL)=("publisherEpoch" IS NULL)),
 CHECK ("state"<>'PUBLISHED' OR ("publishedById" IS NOT NULL AND jsonb_array_length("audience")>0)),
 CHECK ("state"<>'DRAFT' OR ("publishedById" IS NULL AND jsonb_array_length("audience")=0))
);
CREATE INDEX "VideoEntry_state_position_id_idx" ON "VideoEntry"("state","position","id");
CREATE TABLE "VideoRevision" (
 "videoId" UUID NOT NULL REFERENCES "VideoEntry"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "version" INTEGER NOT NULL CHECK ("version">0), "snapshot" JSONB NOT NULL CHECK (jsonb_typeof("snapshot")='object'),
 "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "VideoRevision_pkey" PRIMARY KEY ("videoId","version")
);
CREATE TABLE "VideoCommand" (
 "id" UUID PRIMARY KEY, "videoId" UUID NOT NULL REFERENCES "VideoEntry"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "version" INTEGER NOT NULL CHECK ("version">0),
 "operation" VARCHAR(20) NOT NULL CHECK ("operation" IN ('UPLOAD','SAVE_DRAFT','PUBLISH','ARCHIVE','RESTORE_DRAFT')),
 "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "actorEpoch" INTEGER NOT NULL CHECK ("actorEpoch">0),
 "digest" CHAR(64) NOT NULL CHECK ("digest" ~ '^[a-f0-9]{64}$'), "transactionId" BIGINT NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "VideoCommand_videoId_version_key" UNIQUE ("videoId","version")
);

-- All native reservations also take this lock before their quota read, in a
-- serializable transaction. Reservations survive filesystem failures.
CREATE FUNCTION fai_video_asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE used_bytes bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'VIDEO_HISTORY_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('FAI_VIDEO_LIBRARY_QUOTA_V1',0));
  SELECT coalesce(sum("sizeBytes"),0) INTO used_bytes FROM "VideoAsset";
  IF used_bytes+NEW."sizeBytes">1073741824 OR NEW."state"<>'RESERVED' THEN RAISE EXCEPTION 'VIDEO_QUOTA_OR_RESERVATION_INVALID'; END IF;
 ELSE
  IF OLD."state"<>'RESERVED' OR NEW."state"<>'READY' OR NEW."readyAt" IS NULL
   OR (to_jsonb(NEW)-'state'-'readyAt') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'readyAt') THEN
   RAISE EXCEPTION 'VIDEO_ASSET_IMMUTABLE';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "VideoAsset_guard" BEFORE INSERT OR UPDATE OR DELETE ON "VideoAsset" FOR EACH ROW EXECUTE FUNCTION fai_video_asset_guard();
CREATE FUNCTION fai_video_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'VIDEO_HISTORY_IMMUTABLE'; END $$;
CREATE TRIGGER "VideoRevision_immutable" BEFORE UPDATE OR DELETE ON "VideoRevision" FOR EACH ROW EXECUTE FUNCTION fai_video_immutable();
CREATE TRIGGER "VideoCommand_immutable" BEFORE UPDATE OR DELETE ON "VideoCommand" FOR EACH ROW EXECUTE FUNCTION fai_video_immutable();
CREATE FUNCTION fai_video_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'VIDEO_HISTORY_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."state"<>'DRAFT' OR NEW."version"<>1 THEN RAISE EXCEPTION 'VIDEO_INITIAL_DRAFT_REQUIRED'; END IF;
 ELSE
  IF NEW."id"<>OLD."id" OR NEW."createdById"<>OLD."createdById" OR NEW."createdAt"<>OLD."createdAt"
    OR NEW."version"<>OLD."version"+1
    OR (OLD."state"='ARCHIVED' AND NEW."state"<>'DRAFT') THEN
   RAISE EXCEPTION 'VIDEO_VERSION_OR_LIFECYCLE_INVALID';
  END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM "VideoAsset" WHERE "id"=NEW."fileId" AND "state"='READY') THEN RAISE EXCEPTION 'VIDEO_FILE_NOT_READY'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "VideoEntry_guard" BEFORE INSERT OR UPDATE OR DELETE ON "VideoEntry" FOR EACH ROW EXECUTE FUNCTION fai_video_entry_guard();
CREATE FUNCTION fai_video_atomic_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "VideoRevision" r JOIN "VideoCommand" c ON c."videoId"=r."videoId" AND c."version"=r."version"
   WHERE r."videoId"=NEW."id" AND r."version"=NEW."version" AND r."snapshot"=to_jsonb(NEW)
   AND r."actorId"=c."actorId" AND c."transactionId"=txid_current()
   AND EXISTS(SELECT 1 FROM "AuditLog" a WHERE a."actorId"=c."actorId" AND a."event"='VIDEO_LIBRARY_MUTATION'
     AND a."entityType"='VideoEntry' AND a."entityId"=NEW."id"::text AND a."after"->>'commandId'=c."id"::text))
 THEN RAISE EXCEPTION 'VIDEO_ATOMIC_HISTORY_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "VideoEntry_atomic_history" AFTER INSERT OR UPDATE ON "VideoEntry"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_video_atomic_history();
COMMIT;
