BEGIN;

CREATE INDEX "Lead_pipeline_cursor_idx"
  ON "Lead" ("deletedAt", "nextActionDate", "updatedAt" DESC, "id" DESC);
CREATE INDEX "Lead_assignee_pipeline_cursor_idx"
  ON "Lead" ("assignedToId", "deletedAt", "nextActionDate", "updatedAt" DESC, "id" DESC);

CREATE INDEX "Client_active_cursor_idx"
  ON "Client" ("deletedAt", "updatedAt" DESC, "id" DESC);
CREATE INDEX "Client_sales_owner_cursor_idx"
  ON "Client" ("salesOwnerId", "deletedAt", "updatedAt" DESC, "id" DESC);
CREATE INDEX "Client_consultant_cursor_idx"
  ON "Client" ("consultantId", "deletedAt", "updatedAt" DESC, "id" DESC);

CREATE INDEX "ClientService_client_status_cursor_idx"
  ON "ClientService" ("clientId", "deletedAt", "operationalStatus", "statusUpdatedAt" DESC, "id" DESC);
CREATE INDEX "Document_client_active_idx"
  ON "Document" ("clientId", "deletedAt");

CREATE INDEX "Task_active_due_cursor_idx"
  ON "Task" ("deletedAt", "dueAt", "updatedAt" DESC, "id" DESC);
CREATE INDEX "Task_assignee_due_cursor_idx"
  ON "Task" ("assignedToId", "deletedAt", "dueAt", "id" DESC);

CREATE INDEX "AiRun_created_cursor_idx"
  ON "AiRun" ("createdAt" DESC, "id" DESC);
CREATE INDEX "AiOutput_created_cursor_idx"
  ON "AiOutput" ("createdAt" DESC, "id" DESC);

COMMIT;
