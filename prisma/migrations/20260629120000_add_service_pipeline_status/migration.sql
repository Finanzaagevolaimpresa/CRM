CREATE TYPE "OperationalServiceStatus" AS ENUM ('nuova', 'pre_analisi', 'documenti_richiesti', 'documenti_ricevuti', 'in_valutazione', 'proposta_inviata', 'domanda_in_preparazione', 'domanda_presentata', 'in_istruttoria', 'approvata_deliberata', 'respinta_non_procedibile', 'rendicontazione', 'chiusa', 'archiviata');

ALTER TABLE "ClientService"
  ADD COLUMN "operationalStatus" "OperationalServiceStatus" NOT NULL DEFAULT 'nuova',
  ADD COLUMN "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "practiceType" TEXT,
  ADD COLUMN "requestedAmount" DECIMAL(65,30),
  ADD COLUMN "plannedInvestment" DECIMAL(65,30),
  ADD COLUMN "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "operationalNotes" TEXT;

CREATE INDEX "ClientService_operationalStatus_idx" ON "ClientService"("operationalStatus");
CREATE INDEX "ClientService_statusUpdatedAt_idx" ON "ClientService"("statusUpdatedAt");
