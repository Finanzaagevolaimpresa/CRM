BEGIN;
-- Additive test candidate only. Never a production migration or activation.
DO $$ BEGIN
  IF current_database() <> 'fai_crm_test' OR
    (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database())
      IS DISTINCT FROM 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1' THEN
    RAISE EXCEPTION 'ORDINARY_EMAIL_SYNTHETIC_DATABASE_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) <> 50
    OR to_regclass('public."OrdinaryEmailOutcome"') IS NULL THEN
    RAISE EXCEPTION 'ORDINARY_EMAIL_INBOUND_BASE_REQUIRED';
  END IF;
END $$;

CREATE TABLE "OrdinaryEmailInboundStream" (
  "id" UUID PRIMARY KEY,
  "mailboxId" UUID NOT NULL REFERENCES "CommunicationMailbox"("id") ON DELETE RESTRICT,
  "mailboxRevision" INTEGER NOT NULL CHECK ("mailboxRevision">0),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0),
  "descriptor" JSONB NOT NULL CHECK (jsonb_typeof("descriptor")='object'),
  "descriptorHash" CHAR(64) NOT NULL CHECK ("descriptorHash" ~ '^[a-f0-9]{64}$'),
  "qualificationReference" VARCHAR(128) NOT NULL,
  "validUntil" TIMESTAMPTZ(3) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "cursor" VARCHAR(512),
  "cursorVersion" INTEGER NOT NULL DEFAULT 0 CHECK ("cursorVersion">=0),
  UNIQUE ("mailboxId","descriptorHash")
);
CREATE UNIQUE INDEX "OrdinaryEmailInboundStream_enabled" ON "OrdinaryEmailInboundStream"("mailboxId") WHERE "enabled";
CREATE TABLE "OrdinaryEmailInboundBatch" (
  "id" UUID PRIMARY KEY,
  "streamId" UUID NOT NULL REFERENCES "OrdinaryEmailInboundStream"("id") ON DELETE RESTRICT,
  "streamRevision" INTEGER NOT NULL CHECK ("streamRevision">0),
  "fromVersion" INTEGER NOT NULL CHECK ("fromVersion">=0),
  "fromCursorHash" CHAR(64) NOT NULL CHECK ("fromCursorHash" ~ '^[a-f0-9]{64}$'),
  "nextCursorHash" CHAR(64) NOT NULL CHECK ("nextCursorHash" ~ '^[a-f0-9]{64}$'),
  "batchHash" CHAR(64) NOT NULL CHECK ("batchHash" ~ '^[a-f0-9]{64}$'),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("streamId","fromVersion")
);
CREATE TABLE "OrdinaryEmailInboundItem" (
  "id" UUID PRIMARY KEY,
  "streamId" UUID NOT NULL REFERENCES "OrdinaryEmailInboundStream"("id") ON DELETE RESTRICT,
  "batchId" UUID NOT NULL REFERENCES "OrdinaryEmailInboundBatch"("id") ON DELETE RESTRICT,
  "providerId" VARCHAR(255) NOT NULL CHECK (length("providerId")>0),
  "payload" JSONB NOT NULL CHECK (jsonb_typeof("payload")='object'),
  "payloadHash" CHAR(64) NOT NULL CHECK ("payloadHash" ~ '^[a-f0-9]{64}$'),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("streamId","providerId")
);
CREATE TABLE "OrdinaryEmailInboundConflict" (
  "id" UUID PRIMARY KEY,
  "itemId" UUID NOT NULL REFERENCES "OrdinaryEmailInboundItem"("id") ON DELETE RESTRICT,
  "batchId" UUID NOT NULL REFERENCES "OrdinaryEmailInboundBatch"("id") ON DELETE RESTRICT,
  "observedHash" CHAR(64) NOT NULL CHECK ("observedHash" ~ '^[a-f0-9]{64}$'),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("itemId","observedHash")
);
CREATE TABLE "OrdinaryEmailInboundLink" (
  "itemId" UUID PRIMARY KEY REFERENCES "OrdinaryEmailInboundItem"("id") ON DELETE RESTRICT,
  "replyId" UUID NOT NULL UNIQUE REFERENCES "CommunicationReply"("id") ON DELETE RESTRICT,
  "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp()
);
-- Identity, mailbox revision, folder and generation never change in place.
-- A new stream requires explicit reconciliation; no automatic cursor reset.
CREATE FUNCTION "ordinary_inbound_stream_update"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW."id",NEW."mailboxId",NEW."mailboxRevision",NEW."descriptor",NEW."descriptorHash") IS DISTINCT FROM
     (OLD."id",OLD."mailboxId",OLD."mailboxRevision",OLD."descriptor",OLD."descriptorHash") THEN
    RAISE EXCEPTION 'ORDINARY_INBOUND_STREAM_IMMUTABLE';
  END IF;
  IF NEW."revision"=OLD."revision"+1 THEN
    IF (NEW."cursor",NEW."cursorVersion") IS DISTINCT FROM (OLD."cursor",OLD."cursorVersion") THEN
      RAISE EXCEPTION 'ORDINARY_INBOUND_CURSOR_RECONCILIATION_REQUIRED';
    END IF;
  ELSIF NEW."revision"=OLD."revision" AND NEW."cursorVersion"=OLD."cursorVersion"+1 THEN
    IF (NEW."qualificationReference",NEW."validUntil",NEW."enabled") IS DISTINCT FROM
       (OLD."qualificationReference",OLD."validUntil",OLD."enabled") OR NOT OLD."enabled" OR
       NEW."cursor" IS NULL OR NEW."cursor" IS NOT DISTINCT FROM OLD."cursor" OR NOT EXISTS (
         SELECT 1 FROM "OrdinaryEmailInboundBatch" WHERE "streamId"=OLD."id"
           AND "streamRevision"=OLD."revision" AND "fromVersion"=OLD."cursorVersion") THEN
      RAISE EXCEPTION 'ORDINARY_INBOUND_CURSOR_RECEIPT_REQUIRED';
    END IF;
  ELSE RAISE EXCEPTION 'ORDINARY_INBOUND_REVISION_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OrdinaryEmailInboundStream_revision" BEFORE UPDATE ON "OrdinaryEmailInboundStream"
  FOR EACH ROW EXECUTE FUNCTION "ordinary_inbound_stream_update"();
CREATE TRIGGER "OrdinaryEmailInboundStream_no_delete" BEFORE DELETE ON "OrdinaryEmailInboundStream"
  FOR EACH ROW EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE FUNCTION "ordinary_inbound_item_binding"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "OrdinaryEmailInboundBatch" WHERE "id"=NEW."batchId" AND "streamId"=NEW."streamId") THEN
    RAISE EXCEPTION 'ORDINARY_INBOUND_ITEM_BINDING';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OrdinaryEmailInboundItem_binding" BEFORE INSERT ON "OrdinaryEmailInboundItem"
  FOR EACH ROW EXECUTE FUNCTION "ordinary_inbound_item_binding"();
CREATE FUNCTION "ordinary_inbound_evidence_binding"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_TABLE_NAME='OrdinaryEmailInboundConflict' THEN
    IF NOT EXISTS (SELECT 1 FROM "OrdinaryEmailInboundItem" i JOIN "OrdinaryEmailInboundBatch" b ON b."streamId"=i."streamId"
      WHERE i."id"=NEW."itemId" AND b."id"=NEW."batchId" AND NEW."observedHash"<>i."payloadHash") THEN
      RAISE EXCEPTION 'ORDINARY_INBOUND_CONFLICT_BINDING';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "OrdinaryEmailInboundItem" i JOIN "OrdinaryEmailInboundStream" s ON s."id"=i."streamId"
      JOIN "CommunicationReply" r ON r."id"=NEW."replyId" WHERE i."id"=NEW."itemId"
        AND r."canonicalMailboxId"=s."mailboxId" AND r."messageId" IS NOT NULL
        AND r."externalMessageId"='ordinary-inbound:'||i."id"::text
        AND r."sender"=i."payload"->>'sender' AND r."subject"=i."payload"->>'subject' AND r."body"=i."payload"->>'body'
        AND r."inReplyTo" IS NOT DISTINCT FROM i."payload"->>'inReplyTo'
        AND r."receivedAt"=(i."payload"->>'receivedAt')::timestamptz
        AND r."linkedById"=NEW."actorId" AND r."acquiredById"=NEW."actorId") THEN
      RAISE EXCEPTION 'ORDINARY_INBOUND_LINK_BINDING';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OrdinaryEmailInboundConflict_binding" BEFORE INSERT ON "OrdinaryEmailInboundConflict"
  FOR EACH ROW EXECUTE FUNCTION "ordinary_inbound_evidence_binding"();
CREATE TRIGGER "OrdinaryEmailInboundLink_binding" BEFORE INSERT ON "OrdinaryEmailInboundLink"
  FOR EACH ROW EXECUTE FUNCTION "ordinary_inbound_evidence_binding"();
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['OrdinaryEmailInboundBatch','OrdinaryEmailInboundItem','OrdinaryEmailInboundConflict','OrdinaryEmailInboundLink'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ordinary_email_immutable()',name||'_immutable',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['OrdinaryEmailInboundStream','OrdinaryEmailInboundBatch','OrdinaryEmailInboundItem','OrdinaryEmailInboundConflict','OrdinaryEmailInboundLink'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I EXECUTE FUNCTION ordinary_email_immutable()',name||'_no_truncate',name);
  END LOOP;
END $$;
COMMIT;
