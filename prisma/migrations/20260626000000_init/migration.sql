-- Initial schema for FAI CRM generated from prisma/schema.prisma.

CREATE TYPE "RoleCode" AS ENUM ('admin', 'direzione', 'commerciale', 'consulente', 'revisore', 'backoffice', 'amministrazione');
CREATE TYPE "LeadStatus" AS ENUM ('nuovo', 'da_contattare', 'contattato', 'qualificato', 'non_qualificato', 'appuntamento_fissato', 'preanalisi_richiesta', 'offerta_inviata', 'contratto_inviato', 'cliente_acquisito', 'perso', 'archiviato');
CREATE TYPE "ClientType" AS ENUM ('persona_fisica', 'ditta_individuale', 'societa', 'professionista', 'soggetto_da_costituire', 'associazione', 'altro');
CREATE TYPE "ProjectStatus" AS ENUM ('idea', 'raccolta_dati', 'in_analisi', 'preanalisi_pronta', 'dossier_pronto', 'contratto_in_attesa', 'pratica_attiva', 'chiuso', 'archiviato');
CREATE TYPE "ExpenseCategory" AS ENUM ('attrezzature', 'macchinari', 'mezzi', 'ristrutturazione', 'opere_edili', 'impianti', 'software', 'hardware', 'marketing', 'formazione', 'consulenze', 'liquidita', 'acquisto_immobile', 'affitto', 'personale', 'merce', 'eventi', 'spese_legali', 'altro');
CREATE TYPE "RiskLevel" AS ENUM ('basso', 'medio', 'alto', 'non_valutabile');
CREATE TYPE "MeasureStatus" AS ENUM ('aperta', 'in_apertura', 'chiusa', 'a_sportello', 'click_day', 'a_graduatoria', 'da_verificare');
CREATE TYPE "DocumentStatus" AS ENUM ('caricato', 'classificato', 'estratto', 'da_verificare', 'verificato', 'respinto', 'scaduto', 'archiviato');
CREATE TYPE "ReviewStatus" AS ENUM ('da_avviare', 'raccolta_dati', 'analisi_ai', 'bozza_generata', 'da_revisionare', 'revisionata', 'approvata_internamente', 'archiviata');
CREATE TYPE "DossierStatus" AS ENUM ('bozza_ai', 'bozza_consulente', 'in_revisione', 'approvato_internamente', 'consegnabile_manualmente', 'consegnato_manualmente', 'archiviato');
CREATE TYPE "ContractStatus" AS ENUM ('da_preparare', 'preparato', 'inviato_manualmente', 'firmato', 'non_firmato', 'annullato', 'archiviato');
CREATE TYPE "PaymentStatus" AS ENUM ('da_incassare', 'parziale', 'incassato', 'scaduto', 'stornato', 'rimborsato');
CREATE TYPE "AiOutputStatus" AS ENUM ('needs_review', 'flagged', 'approved', 'rejected', 'archived');

CREATE TABLE "User" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" "RoleCode" NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "Lead" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT,
  "source" TEXT,
  "region" TEXT,
  "province" TEXT,
  "interest" TEXT,
  "declaredInvestment" DECIMAL(65,30),
  "status" "LeadStatus" NOT NULL DEFAULT 'nuovo',
  "commercialStatus" TEXT,
  "assignedToId" TEXT,
  "nextAction" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "Client" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "type" "ClientType" NOT NULL,
  "displayName" TEXT NOT NULL,
  "leadId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'attivo',
  "salesOwnerId" TEXT,
  "consultantId" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "Company" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "vatNumber" TEXT,
  "taxCode" TEXT,
  "rea" TEXT,
  "pec" TEXT,
  "legalAddress" TEXT,
  "operatingAddress" TEXT,
  "region" TEXT,
  "province" TEXT,
  "city" TEXT,
  "legalForm" TEXT,
  "atecoCode" TEXT,
  "atecoDescription" TEXT,
  "incorporationDate" TIMESTAMP(3),
  "activityStartDate" TIMESTAMP(3),
  "activityStatus" TEXT,
  "employees" INTEGER,
  "annualRevenue" DECIMAL(65,30),
  "durcStatus" TEXT,
  "taxRegime" TEXT,
  "notes" TEXT,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "Person" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "taxCode" TEXT,
  "notes" TEXT,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "CompanyPerson" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "companyId" TEXT NOT NULL,
  "personId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "ownershipPercent" DECIMAL(65,30)
);

CREATE TABLE "IncorporationSubject" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "promoterClientId" TEXT,
  "hypotheticalLegalForm" TEXT,
  "hypotheticalAteco" TEXT,
  "plannedActivity" TEXT,
  "region" TEXT,
  "province" TEXT,
  "expectedStartDate" TIMESTAMP(3),
  "estimatedInvestment" DECIMAL(65,30),
  "status" TEXT,
  "issues" TEXT,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "Project" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL,
  "companyId" TEXT,
  "incorporationSubjectId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "totalInvestment" DECIMAL(65,30),
  "requestedAmount" DECIMAL(65,30),
  "startTiming" TEXT,
  "region" TEXT,
  "province" TEXT,
  "sector" TEXT,
  "status" "ProjectStatus" NOT NULL DEFAULT 'idea',
  "priority" TEXT NOT NULL DEFAULT 'media',
  "scenarioA" TEXT,
  "scenarioB" TEXT,
  "blockingConditions" TEXT,
  "consultantId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "ProjectExpense" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "projectId" TEXT NOT NULL,
  "category" "ExpenseCategory" NOT NULL,
  "description" TEXT NOT NULL,
  "amount" DECIMAL(65,30) NOT NULL,
  "estimated" BOOLEAN NOT NULL DEFAULT TRUE,
  "potentiallyEligible" BOOLEAN NOT NULL DEFAULT FALSE,
  "eligibilityNotes" TEXT,
  "priority" TEXT
);

CREATE TABLE "BankabilityAssessment" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL,
  "companyId" TEXT,
  "projectId" TEXT,
  "declaredCrif" TEXT,
  "declaredCentralRisk" TEXT,
  "protestsOrLiens" TEXT,
  "paymentDelays" TEXT,
  "activeLoans" TEXT,
  "taxDebts" TEXT,
  "socialSecurityDebts" TEXT,
  "revenue" DECIMAL(65,30),
  "ebitda" DECIMAL(65,30),
  "netProfit" DECIMAL(65,30),
  "equity" DECIMAL(65,30),
  "estimatedCashflow" DECIMAL(65,30),
  "estimatedDscr" DECIMAL(65,30),
  "monthlyRent" DECIMAL(65,30),
  "existingMonthlyInstalments" DECIMAL(65,30),
  "availableGuarantees" TEXT,
  "riskLevel" "RiskLevel" NOT NULL DEFAULT 'non_valutabile',
  "riskRationale" TEXT,
  "dataCompleteness" INTEGER NOT NULL DEFAULT 0,
  "humanReviewStatus" TEXT NOT NULL DEFAULT 'da_revisionare',
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "GrantAssessment" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "projectId" TEXT NOT NULL,
  "summary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "MeasureMatch" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "grantAssessmentId" TEXT NOT NULL,
  "internalMeasureName" TEXT NOT NULL,
  "measureStatus" "MeasureStatus" NOT NULL DEFAULT 'da_verificare',
  "opensAt" TIMESTAMP(3),
  "closesAt" TIMESTAMP(3),
  "expectedResult" TEXT,
  "expectedBenefitAmount" DECIMAL(65,30),
  "expectedBenefitPercent" DECIMAL(65,30),
  "difficulty" TEXT,
  "difficultyRationale" TEXT,
  "eligibleExpenses" TEXT,
  "ineligibleExpenses" TEXT,
  "blockingConditions" TEXT,
  "requiredDocuments" TEXT,
  "sourceStatus" TEXT,
  "officialSourceUrl" TEXT,
  "verificationRequired" BOOLEAN NOT NULL DEFAULT TRUE,
  "notes" TEXT
);

CREATE TABLE "CumulabilityAssessment" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "projectId" TEXT NOT NULL,
  "grantAssessmentId" TEXT,
  "summary" TEXT,
  "legalResult" TEXT,
  "technicalResult" TEXT,
  "deMinimisRisk" TEXT,
  "rnaRisk" TEXT,
  "doubleFundingRisk" TEXT,
  "timingConflicts" TEXT,
  "conclusion" TEXT,
  "humanReviewStatus" TEXT NOT NULL DEFAULT 'da_revisionare'
);

CREATE TABLE "Document" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT,
  "companyId" TEXT,
  "projectId" TEXT,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "storagePath" TEXT NOT NULL,
  "checksum" TEXT,
  "uploadedById" TEXT NOT NULL,
  "status" "DocumentStatus" NOT NULL DEFAULT 'caricato',
  "visibilityLevel" TEXT NOT NULL DEFAULT 'interno',
  "containsSensitiveData" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "DocumentVersion" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "documentId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "storagePath" TEXT NOT NULL,
  "checksum" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "DocumentExtraction" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "documentId" TEXT NOT NULL,
  "extractedJson" JSONB,
  "extractedText" TEXT,
  "status" TEXT NOT NULL DEFAULT 'da_verificare',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "VisuraAnalysis" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "documentId" TEXT NOT NULL,
  "companyId" TEXT,
  "findings" JSONB,
  "humanReviewStatus" TEXT NOT NULL DEFAULT 'da_revisionare',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "PreAnalysis" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "projectId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "companyId" TEXT,
  "status" "ReviewStatus" NOT NULL DEFAULT 'da_avviare',
  "internalSummary" TEXT,
  "clientReadySummary" TEXT,
  "scenarioA" TEXT,
  "scenarioB" TEXT,
  "blockingConditions" TEXT,
  "requiredDocuments" TEXT,
  "nextActions" TEXT,
  "commercialRecommendation" TEXT,
  "aiRunId" TEXT,
  "reviewedById" TEXT,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3)
);

CREATE TABLE "Dossier" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "preAnalysisId" TEXT,
  "projectId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" "DossierStatus" NOT NULL DEFAULT 'bozza_ai',
  "markdownContent" TEXT,
  "jsonContent" JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  "aiRunId" TEXT,
  "modifiedById" TEXT,
  "reviewedById" TEXT,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "docxExportPath" TEXT,
  "pdfExportPath" TEXT
);

CREATE TABLE "Contract" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL,
  "projectId" TEXT,
  "contractNumber" TEXT NOT NULL,
  "serviceName" TEXT NOT NULL,
  "serviceDescription" TEXT,
  "taxableAmount" DECIMAL(65,30) NOT NULL,
  "vatAmount" DECIMAL(65,30) NOT NULL,
  "totalAmount" DECIMAL(65,30) NOT NULL,
  "status" "ContractStatus" NOT NULL DEFAULT 'da_preparare',
  "sentAt" TIMESTAMP(3),
  "signedAt" TIMESTAMP(3),
  "signedDocumentId" TEXT,
  "notes" TEXT
);

CREATE TABLE "Payment" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "contractId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "taxableAmount" DECIMAL(65,30) NOT NULL,
  "vatAmount" DECIMAL(65,30) NOT NULL,
  "totalAmount" DECIMAL(65,30) NOT NULL,
  "method" TEXT,
  "status" "PaymentStatus" NOT NULL DEFAULT 'da_incassare',
  "dueDate" TIMESTAMP(3),
  "collectedAt" TIMESTAMP(3),
  "accountingDocumentId" TEXT,
  "notes" TEXT
);

CREATE TABLE "Task" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT,
  "companyId" TEXT,
  "projectId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "type" TEXT,
  "priority" TEXT NOT NULL DEFAULT 'media',
  "status" TEXT NOT NULL DEFAULT 'aperto',
  "assignedToId" TEXT,
  "dueAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdById" TEXT
);

CREATE TABLE "Deadline" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "title" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'aperta'
);

CREATE TABLE "AiAgent" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "inputSchema" JSONB NOT NULL,
  "outputSchema" JSONB NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE "AiRun" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "agentId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'completed',
  "input" JSONB,
  "output" JSONB,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "AiOutput" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "aiRunId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "status" "AiOutputStatus" NOT NULL DEFAULT 'needs_review',
  "requiresHumanReview" BOOLEAN NOT NULL DEFAULT TRUE,
  "forbiddenPhrases" JSONB,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "AiAgentMessage" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "aiRunId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "ActivityLog" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "entityType" TEXT,
  "entityId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "AuditLog" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "actorId" TEXT,
  "event" TEXT NOT NULL,
  "entityType" TEXT,
  "entityId" TEXT,
  "before" JSONB,
  "after" JSONB,
  "ipAddress" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "Contract_contractNumber_key" ON "Contract"("contractNumber");
CREATE UNIQUE INDEX "AiAgent_code_key" ON "AiAgent"("code");
