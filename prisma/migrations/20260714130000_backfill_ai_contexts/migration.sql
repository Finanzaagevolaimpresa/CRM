-- AiOutput is the authoritative source for the context of legacy AI runs.
-- Complete only missing values supported by active, mutually consistent records;
-- contradictory or dangling legacy links are intentionally left untouched.
WITH "validServiceContexts" AS (
  SELECT
    service."id",
    service."clientId",
    service."projectId"
  FROM "ClientService" AS service
  INNER JOIN "Client" AS client
    ON client."id" = service."clientId"
   AND client."deletedAt" IS NULL
  LEFT JOIN "Project" AS project
    ON project."id" = service."projectId"
   AND project."clientId" = service."clientId"
   AND project."deletedAt" IS NULL
  WHERE service."deletedAt" IS NULL
    AND (service."projectId" IS NULL OR project."id" IS NOT NULL)
)
UPDATE "AiOutput" AS output
SET
  "clientId" = COALESCE(output."clientId", service."clientId"),
  "projectId" = COALESCE(output."projectId", service."projectId")
FROM "validServiceContexts" AS service
WHERE output."clientServiceId" = service."id"
  AND (output."clientId" IS NULL OR output."projectId" IS NULL)
  AND (output."clientId" IS NULL OR output."clientId" = service."clientId")
  AND (
    output."projectId" IS NULL
    OR EXISTS (
      SELECT 1
      FROM "Project" AS output_project
      WHERE output_project."id" = output."projectId"
        AND output_project."clientId" = service."clientId"
        AND output_project."deletedAt" IS NULL
    )
  )
  AND (
    output."projectId" IS NULL
    OR service."projectId" IS NULL
    OR output."projectId" = service."projectId"
  );

-- A valid project is also sufficient to recover a missing client link. If a
-- service link exists, it must identify the same client and a compatible project.
WITH "validProjectContexts" AS (
  SELECT project."id", project."clientId"
  FROM "Project" AS project
  INNER JOIN "Client" AS client
    ON client."id" = project."clientId"
   AND client."deletedAt" IS NULL
  WHERE project."deletedAt" IS NULL
)
UPDATE "AiOutput" AS output
SET "clientId" = project."clientId"
FROM "validProjectContexts" AS project
WHERE output."clientId" IS NULL
  AND output."projectId" = project."id"
  AND (
    output."clientServiceId" IS NULL
    OR EXISTS (
      SELECT 1
      FROM "ClientService" AS service
      LEFT JOIN "Project" AS service_project
        ON service_project."id" = service."projectId"
       AND service_project."clientId" = service."clientId"
       AND service_project."deletedAt" IS NULL
      WHERE service."id" = output."clientServiceId"
        AND service."clientId" = project."clientId"
        AND service."deletedAt" IS NULL
        AND (service."projectId" IS NULL OR service_project."id" IS NOT NULL)
        AND (service."projectId" IS NULL OR service."projectId" = output."projectId")
    )
  );

-- Copy a context to AiRun only when every output belonging to the run has a
-- valid context and the complete (client, service, project) tuple is unique.
-- ROW(...), unlike separate COUNT(DISTINCT ...) calls, also distinguishes NULLs.
WITH "validatedOutputContexts" AS (
  SELECT
    output."aiRunId",
    output."clientId",
    output."clientServiceId",
    output."projectId",
    CASE
      WHEN output."clientId" IS NULL THEN
        output."clientServiceId" IS NULL AND output."projectId" IS NULL
      ELSE
        client."id" IS NOT NULL
        AND (output."projectId" IS NULL OR project."id" IS NOT NULL)
        AND (
          output."clientServiceId" IS NULL
          OR (
            service."id" IS NOT NULL
            AND (service."projectId" IS NULL OR service_project."id" IS NOT NULL)
            AND (
              output."projectId" IS NULL
              OR service."projectId" IS NULL
              OR service."projectId" = output."projectId"
            )
          )
        )
    END AS "isValid"
  FROM "AiOutput" AS output
  LEFT JOIN "Client" AS client
    ON client."id" = output."clientId"
   AND client."deletedAt" IS NULL
  LEFT JOIN "Project" AS project
    ON project."id" = output."projectId"
   AND project."clientId" = output."clientId"
   AND project."deletedAt" IS NULL
  LEFT JOIN "ClientService" AS service
    ON service."id" = output."clientServiceId"
   AND service."clientId" = output."clientId"
   AND service."deletedAt" IS NULL
  LEFT JOIN "Project" AS service_project
    ON service_project."id" = service."projectId"
   AND service_project."clientId" = service."clientId"
   AND service_project."deletedAt" IS NULL
),
"uniqueRunContexts" AS (
  SELECT
    context."aiRunId",
    MIN(context."clientId") AS "clientId",
    MIN(context."clientServiceId") AS "clientServiceId",
    MIN(context."projectId") AS "projectId"
  FROM "validatedOutputContexts" AS context
  GROUP BY context."aiRunId"
  HAVING BOOL_AND(context."isValid")
     AND COUNT(DISTINCT ROW(
       context."clientId",
       context."clientServiceId",
       context."projectId"
     )) = 1
)
UPDATE "AiRun" AS run
SET
  "clientId" = context."clientId",
  "clientServiceId" = context."clientServiceId",
  "projectId" = context."projectId"
FROM "uniqueRunContexts" AS context
WHERE run."id" = context."aiRunId";
