BEGIN;

-- No real identity, project or recipient is enrolled by this migration.
CREATE TABLE "SelectiveAccessAuthority" (
  "id" TEXT NOT NULL DEFAULT 'project-sharing',
  "userId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "SelectiveAccessAuthority_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SelectiveAccessAuthority_singleton" CHECK ("id" = 'project-sharing' AND "revision" > 0),
  CONSTRAINT "SelectiveAccessAuthority_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "SelectiveAccessAuthority_userId_key" ON "SelectiveAccessAuthority"("userId");

CREATE TABLE "SelectiveProjectGrant" (
  "id" UUID NOT NULL,
  "projectId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "selection" JSONB NOT NULL,
  "approvedById" TEXT NOT NULL,
  "authorityRevision" INTEGER NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "keyVersion" INTEGER NOT NULL,
  "proof" TEXT NOT NULL,
  CONSTRAINT "SelectiveProjectGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SelectiveProjectGrant_values" CHECK ("revision" > 0 AND "authorityRevision" > 0 AND "keyVersion" > 0 AND "approvedById" <> "recipientId" AND ("expiresAt" IS NULL OR "expiresAt" > "approvedAt")),
  CONSTRAINT "SelectiveProjectGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SelectiveProjectGrant_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SelectiveProjectGrant_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "SelectiveProjectGrant_projectId_recipientId_key" ON "SelectiveProjectGrant"("projectId", "recipientId");
CREATE INDEX "SelectiveProjectGrant_recipientId_idx" ON "SelectiveProjectGrant"("recipientId");

-- A revoked/expired perimeter must never disappear and restore broad legacy rights.
CREATE FUNCTION "selective_project_perimeter_retained"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SELECTIVE_PERIMETER_MUST_BE_RETAINED'; END IF;
  IF NEW."projectId" <> OLD."projectId" OR NEW."recipientId" <> OLD."recipientId" OR NEW."id" <> OLD."id" THEN
    RAISE EXCEPTION 'SELECTIVE_PERIMETER_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "selective_project_perimeter_retained" BEFORE DELETE OR UPDATE ON "SelectiveProjectGrant"
FOR EACH ROW EXECUTE FUNCTION "selective_project_perimeter_retained"();

COMMIT;
