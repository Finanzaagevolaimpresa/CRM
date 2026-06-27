CREATE TYPE "ServiceStatus" AS ENUM ('richiesto','pagato','raccolta_documenti','in_lavorazione','bozza_ai','revisione_umana','consegnabile','consegnato','sospeso','chiuso','archiviato');
CREATE TYPE "ServiceArea" AS ENUM ('anagrafica','bancabilita','finanziamento_aziendale','bandi_finanza_agevolata','progetto_investimento','contratti','pagamenti','dossier','output_ai','altro');

CREATE TABLE "ServiceCatalog" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "category" TEXT NOT NULL,
  "basePrice" DECIMAL(65,30),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ServiceCatalog_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ServiceCatalog_code_key" ON "ServiceCatalog"("code");

CREATE TABLE "ClientService" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "companyId" TEXT,
  "projectId" TEXT,
  "serviceCatalogId" TEXT NOT NULL,
  "contractId" TEXT,
  "paymentId" TEXT,
  "status" "ServiceStatus" NOT NULL DEFAULT 'richiesto',
  "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'da_incassare',
  "assignedToId" TEXT,
  "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueDate" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "internalNotes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "ClientService_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Document" ADD COLUMN "clientServiceId" TEXT;
ALTER TABLE "Document" ADD COLUMN "serviceArea" "ServiceArea" NOT NULL DEFAULT 'altro';
ALTER TABLE "Document" ADD COLUMN "documentCategory" TEXT NOT NULL DEFAULT 'altro';
ALTER TABLE "Task" ADD COLUMN "clientServiceId" TEXT;
ALTER TABLE "AiOutput" ADD COLUMN "clientServiceId" TEXT;

CREATE TABLE "CorporateFinancingAssessment" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "companyId" TEXT,
  "projectId" TEXT,
  "clientServiceId" TEXT,
  "requestedAmount" DECIMAL(65,30),
  "purpose" TEXT,
  "timing" TEXT,
  "ordinaryInstruments" TEXT,
  "mortgage" TEXT,
  "unsecuredLoan" TEXT,
  "leasing" TEXT,
  "factoring" TEXT,
  "invoiceAdvance" TEXT,
  "creditLines" TEXT,
  "mcc" TEXT,
  "guarantees" TEXT,
  "fundingNeed" TEXT,
  "sustainableInstallment" DECIMAL(65,30),
  "dscrCashflow" TEXT,
  "existingDebts" TEXT,
  "criticalIssues" TEXT,
  "scenarioA" TEXT,
  "scenarioB" TEXT,
  "nextAction" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CorporateFinancingAssessment_pkey" PRIMARY KEY ("id")
);
