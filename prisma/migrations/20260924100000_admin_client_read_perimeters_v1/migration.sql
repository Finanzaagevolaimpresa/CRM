BEGIN;

CREATE TABLE "ClientReadGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClientReadGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClientReadGrant_version_positive" CHECK ("version" > 0),
    CONSTRAINT "ClientReadGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ClientReadGrant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ClientReadGrant_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ClientReadGrant_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ClientReadGrant_userId_clientId_key" ON "ClientReadGrant"("userId", "clientId");
CREATE INDEX "ClientReadGrant_userId_active_clientId_idx" ON "ClientReadGrant"("userId", "active", "clientId");
CREATE INDEX "ClientReadGrant_clientId_idx" ON "ClientReadGrant"("clientId");

COMMIT;
