CREATE TABLE "InternalSession" (
  "id" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenDigest" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokedReason" TEXT,
  "revokedByUserId" TEXT,
  CONSTRAINT "InternalSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InternalSession_token_digest_length_check" CHECK (octet_length("tokenDigest") = 32),
  CONSTRAINT "InternalSession_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "InternalSession_revocation_check" CHECK (
    ("revokedAt" IS NULL AND "revokedReason" IS NULL AND "revokedByUserId" IS NULL)
    OR
    ("revokedAt" IS NOT NULL AND "revokedAt" >= "createdAt" AND "revokedReason" IN ('LOGOUT', 'USER_DISABLED', 'INTERNAL_SINGLE', 'INTERNAL_GLOBAL'))
  )
);

CREATE UNIQUE INDEX "InternalSession_tokenDigest_key" ON "InternalSession"("tokenDigest");
CREATE INDEX "InternalSession_user_revocation_expiry_idx" ON "InternalSession"("userId", "revokedAt", "expiresAt");
CREATE INDEX "InternalSession_cleanup_cursor_idx" ON "InternalSession"("expiresAt", "id");

ALTER TABLE "InternalSession" ADD CONSTRAINT "InternalSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "InternalSession" ADD CONSTRAINT "InternalSession_revokedByUserId_fkey"
  FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL;
