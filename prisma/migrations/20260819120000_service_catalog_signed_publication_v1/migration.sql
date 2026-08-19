BEGIN;

CREATE TYPE "ServiceCatalogPriceMode" AS ENUM ('FIXED', 'QUOTE_ONLY');
CREATE TYPE "ServiceCatalogRevisionStatus" AS ENUM ('PUBLISHED', 'RETIRED');

CREATE TABLE "ServiceCatalogRevision" (
  "id" UUID NOT NULL,
  "serviceCatalogId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "publicName" TEXT NOT NULL,
  "shortDescription" TEXT NOT NULL,
  "priceMode" "ServiceCatalogPriceMode" NOT NULL,
  "netPrice" DECIMAL(65,30),
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "vatRateBps" INTEGER NOT NULL DEFAULT 2200,
  "validFrom" TIMESTAMP(3) NOT NULL,
  "validUntil" TIMESTAMP(3),
  "termsVersion" TEXT NOT NULL,
  "checkoutEnabled" BOOLEAN NOT NULL DEFAULT false,
  "autoClientDeliveryAllowed" BOOLEAN NOT NULL DEFAULT false,
  "autoExternalActionAllowed" BOOLEAN NOT NULL DEFAULT false,
  "operationalConditions" JSONB NOT NULL,
  "checklist" JSONB NOT NULL,
  "status" "ServiceCatalogRevisionStatus" NOT NULL DEFAULT 'PUBLISHED',
  "contentHash" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ServiceCatalogRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceCatalogRevision_version_positive_check" CHECK ("version" > 0),
  CONSTRAINT "ServiceCatalogRevision_price_contract_check" CHECK (
    ("priceMode" = 'FIXED' AND "netPrice" > 0)
    OR ("priceMode" = 'QUOTE_ONLY' AND "netPrice" IS NULL)
  ),
  CONSTRAINT "ServiceCatalogRevision_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ServiceCatalogRevision_vat_rate_check" CHECK ("vatRateBps" BETWEEN 0 AND 10000),
  CONSTRAINT "ServiceCatalogRevision_validity_check" CHECK (
    "validUntil" IS NULL OR "validUntil" > "validFrom"
  ),
  CONSTRAINT "ServiceCatalogRevision_content_hash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ServiceCatalogRevision_dormant_checkout_check" CHECK ("checkoutEnabled" = false),
  CONSTRAINT "ServiceCatalogRevision_human_control_check" CHECK (
    "autoClientDeliveryAllowed" = false AND "autoExternalActionAllowed" = false
  ),
  CONSTRAINT "ServiceCatalogRevision_operational_conditions_check" CHECK (
    JSONB_TYPEOF("operationalConditions") = 'array' AND JSONB_ARRAY_LENGTH("operationalConditions") > 0
  ),
  CONSTRAINT "ServiceCatalogRevision_checklist_check" CHECK (
    JSONB_TYPEOF("checklist") = 'array' AND JSONB_ARRAY_LENGTH("checklist") > 0
  )
);

CREATE TABLE "ServiceCatalogPublication" (
  "id" UUID NOT NULL,
  "catalogVersion" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "signatureVersion" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ServiceCatalogPublication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceCatalogPublication_schema_version_check" CHECK ("schemaVersion" = 1),
  CONSTRAINT "ServiceCatalogPublication_signature_version_check" CHECK (
    "signatureVersion" = 'hmac-sha256-v1'
  ),
  CONSTRAINT "ServiceCatalogPublication_key_version_check" CHECK ("keyVersion" > 0),
  CONSTRAINT "ServiceCatalogPublication_payload_check" CHECK (JSONB_TYPEOF("payload") = 'object'),
  CONSTRAINT "ServiceCatalogPublication_payload_hash_check" CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ServiceCatalogPublication_signature_check" CHECK ("signature" ~ '^[A-Za-z0-9_-]{43}$')
);

CREATE UNIQUE INDEX "ServiceCatalogRevision_service_version_key"
  ON "ServiceCatalogRevision"("serviceCatalogId", "version");
CREATE UNIQUE INDEX "ServiceCatalogRevision_content_hash_key"
  ON "ServiceCatalogRevision"("contentHash");
CREATE UNIQUE INDEX "ServiceCatalogRevision_one_published_per_service_key"
  ON "ServiceCatalogRevision"("serviceCatalogId") WHERE "status" = 'PUBLISHED';
CREATE INDEX "ServiceCatalogRevision_status_validity_idx"
  ON "ServiceCatalogRevision"("status", "validFrom", "validUntil");

CREATE UNIQUE INDEX "ServiceCatalogPublication_catalog_version_key"
  ON "ServiceCatalogPublication"("catalogVersion");
CREATE UNIQUE INDEX "ServiceCatalogPublication_payload_signature_key"
  ON "ServiceCatalogPublication"("payloadHash", "signatureVersion", "keyVersion");
CREATE INDEX "ServiceCatalogPublication_published_catalog_idx"
  ON "ServiceCatalogPublication"("publishedAt", "catalogVersion");

ALTER TABLE "ServiceCatalogRevision"
  ADD CONSTRAINT "ServiceCatalogRevision_serviceCatalogId_fkey"
  FOREIGN KEY ("serviceCatalogId") REFERENCES "ServiceCatalog"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "fai_service_catalog_revision_immutable_v1"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."status" = 'PUBLISHED' THEN
    RAISE EXCEPTION 'FAI_SERVICE_CATALOG_PUBLISHED_REVISION_IMMUTABLE';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'PUBLISHED' THEN
    IF NEW."status" = 'RETIRED'
      AND NEW."retiredAt" IS NOT NULL
      AND (TO_JSONB(NEW) - 'status' - 'retiredAt') = (TO_JSONB(OLD) - 'status' - 'retiredAt') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'FAI_SERVICE_CATALOG_PUBLISHED_REVISION_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ServiceCatalogRevision_immutable_trigger"
BEFORE UPDATE OR DELETE ON "ServiceCatalogRevision"
FOR EACH ROW EXECUTE FUNCTION "fai_service_catalog_revision_immutable_v1"();

CREATE FUNCTION "fai_service_catalog_publication_append_only_v1"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'FAI_SERVICE_CATALOG_PUBLICATION_APPEND_ONLY';
END;
$$;

CREATE TRIGGER "ServiceCatalogPublication_append_only_trigger"
BEFORE UPDATE OR DELETE ON "ServiceCatalogPublication"
FOR EACH ROW EXECUTE FUNCTION "fai_service_catalog_publication_append_only_v1"();

INSERT INTO "ServiceCatalog" (
  "id", "code", "name", "description", "category", "basePrice", "active",
  "displayOrder", "createdAt", "updatedAt"
)
VALUES
  ('service-n09-verifica-ai-essenziale', 'verifica_ai_essenziale', 'Verifica AI Essenziale', 'Screening preliminare con esito tecnico soggetto a revisione umana.', 'ai', 190.00, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('service-n09-audit-ai-bancabilita', 'audit_ai_bancabilita', 'Audit AI Bancabilità', 'Analisi tecnica della bancabilità e delle criticità documentali.', 'bancabilita', 390.00, true, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('service-n09-preanalisi-ai-ammissibilita', 'pre_analisi_ai_ammissibilita', 'Pre-Analisi AI Ammissibilità', 'Pre-analisi di coerenza rispetto a misure e requisiti da verificare.', 'finanza_agevolata', 490.00, true, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('service-n09-consulenza-strategica-60', 'consulenza_strategica_60', 'Consulenza Strategica 60 minuti', 'Sessione strategica di sessanta minuti con revisione umana.', 'consulenza', 500.00, true, 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('service-n09-dossier-preanalisi', 'dossier_preanalisi', 'Dossier Preanalisi', 'Dossier strutturato di preanalisi con validazione professionale.', 'dossier', 890.00, true, 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('service-n09-ottimizzazione-ai-progetto', 'ottimizzazione_ai_progetto', 'Ottimizzazione AI Progetto', 'Ottimizzazione assistita del progetto con controllo umano.', 'progetto', 1250.00, true, 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('service-n09-business-plan-banca', 'business_plan_presentazione_bancaria', 'Business Plan & Presentazione Bancaria', 'Business plan e presentazione bancaria soggetti a revisione professionale.', 'bancabilita', 1690.00, true, 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('service-n09-ottimizzazione-aziendale-ai', 'ottimizzazione_aziendale_ai', 'Ottimizzazione Aziendale AI', 'Analisi e ottimizzazione aziendale assistite con revisione umana.', 'strategia_aziendale', 1490.00, true, 8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('service-n09-progetti-digitali', 'progetti_digitali', 'Progetti Digitali', 'Progettazione digitale personalizzata definita mediante preventivo.', 'digitale', NULL, true, 9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('service-n09-gestione-misure', 'gestione_misure', 'Gestione misure', 'Gestione operativa di misure definita mediante preventivo.', 'finanza_agevolata', NULL, true, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('service-n09-rendicontazione', 'rendicontazione', 'Rendicontazione', 'Attività di rendicontazione definita mediante preventivo.', 'rendicontazione', NULL, true, 11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "basePrice" = EXCLUDED."basePrice",
  "active" = true,
  "displayOrder" = EXCLUDED."displayOrder",
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "ServiceCatalog"
SET "active" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" IN ('supporto_finanza_ordinaria', 'supporto_finanza_agevolata');

WITH revision_data (
  "id", "code", "publicName", "shortDescription", "priceMode", "netPrice", "contentHash"
) AS (
  VALUES
    ('00000000-0000-4000-8000-000000000001'::UUID, 'verifica_ai_essenziale', 'Verifica AI Essenziale', 'Screening preliminare con esito tecnico soggetto a revisione umana.', 'FIXED', 190.00, 'b65caabbfbe3254a3b9c1e6ec15fe46f0ac933ea0d5bdf04e5b6422a9b3162ba'),
    ('00000000-0000-4000-8000-000000000002'::UUID, 'audit_ai_bancabilita', 'Audit AI Bancabilità', 'Analisi tecnica della bancabilità e delle criticità documentali.', 'FIXED', 390.00, '3cc766f8e183f303c3a41de46c74b60476378b19c0a5b060aaff5ab0e1b80414'),
    ('00000000-0000-4000-8000-000000000003'::UUID, 'pre_analisi_ai_ammissibilita', 'Pre-Analisi AI Ammissibilità', 'Pre-analisi di coerenza rispetto a misure e requisiti da verificare.', 'FIXED', 490.00, 'f24ef3716ea79137514aee77fd9c10b7b961ddf672c2fcac28db5f8370b4e421'),
    ('00000000-0000-4000-8000-000000000004'::UUID, 'consulenza_strategica_60', 'Consulenza Strategica 60 minuti', 'Sessione strategica di sessanta minuti con revisione umana.', 'FIXED', 500.00, '5417a3d79118131b4ad48971aaa20ed9eadd6534dc8ff4c29e84a29311e6b48f'),
    ('00000000-0000-4000-8000-000000000005'::UUID, 'dossier_preanalisi', 'Dossier Preanalisi', 'Dossier strutturato di preanalisi con validazione professionale.', 'FIXED', 890.00, 'cca3176f5ce832bcc6c963fd9a5c562643ae1d75c82249240fea0f756c75f8a5'),
    ('00000000-0000-4000-8000-000000000006'::UUID, 'ottimizzazione_ai_progetto', 'Ottimizzazione AI Progetto', 'Ottimizzazione assistita del progetto con controllo umano.', 'FIXED', 1250.00, 'ca4e3ed7d3febf3fda7df6b9d60bd9de37cd8ebf1b5955f006df6d1cf1b2858f'),
    ('00000000-0000-4000-8000-000000000007'::UUID, 'business_plan_presentazione_bancaria', 'Business Plan & Presentazione Bancaria', 'Business plan e presentazione bancaria soggetti a revisione professionale.', 'FIXED', 1690.00, '48d041d1b5310147d4849fd87aed1adfb80808d04bf2813053610603ee91e73b'),
    ('00000000-0000-4000-8000-000000000008'::UUID, 'ottimizzazione_aziendale_ai', 'Ottimizzazione Aziendale AI', 'Analisi e ottimizzazione aziendale assistite con revisione umana.', 'FIXED', 1490.00, 'f14463d36dd6d383cf18c0a42d41e378158f38d65284303293511b513a1cbff8'),
    ('00000000-0000-4000-8000-000000000009'::UUID, 'progetti_digitali', 'Progetti Digitali', 'Progettazione digitale personalizzata definita mediante preventivo.', 'QUOTE_ONLY', NULL, 'bcef5084ed8eb1dadb81c675bffcd10a6532a913f3ef8df292418c7a78200343'),
    ('00000000-0000-4000-8000-000000000010'::UUID, 'gestione_misure', 'Gestione misure', 'Gestione operativa di misure definita mediante preventivo.', 'QUOTE_ONLY', NULL, 'ad5f581363adc8c32d375523f3a6fa9eacc519e6d5622d9681ad3a2c875d766d'),
    ('00000000-0000-4000-8000-000000000011'::UUID, 'rendicontazione', 'Rendicontazione', 'Attività di rendicontazione definita mediante preventivo.', 'QUOTE_ONLY', NULL, '7d681ccd1532cc7fa580f7cd273535d369eca884e2a1518b61859e864f8b1db1')
)
INSERT INTO "ServiceCatalogRevision" (
  "id", "serviceCatalogId", "version", "publicName", "shortDescription", "priceMode",
  "netPrice", "currency", "vatRateBps", "validFrom", "validUntil", "termsVersion",
  "checkoutEnabled", "autoClientDeliveryAllowed", "autoExternalActionAllowed",
  "operationalConditions", "checklist", "status", "contentHash", "publishedAt", "createdAt"
)
SELECT
  revision_data."id",
  catalog."id",
  1,
  revision_data."publicName",
  revision_data."shortDescription",
  revision_data."priceMode"::"ServiceCatalogPriceMode",
  revision_data."netPrice",
  'EUR',
  2200,
  TIMESTAMP '2026-07-12 00:00:00',
  NULL,
  'TERMS-v1',
  false,
  false,
  false,
  '["HUMAN_REVIEW_REQUIRED","NO_SUCCESS_FEE","NO_AUTOMATIC_EXTERNAL_ACTION","NO_AUTOMATIC_CLIENT_DELIVERY"]'::JSONB,
  '["REQUEST_COMPLETE","DOCUMENTS_AVAILABLE","HUMAN_REVIEW_COMPLETE"]'::JSONB,
  'PUBLISHED'::"ServiceCatalogRevisionStatus",
  revision_data."contentHash",
  TIMESTAMP '2026-07-12 00:00:00',
  CURRENT_TIMESTAMP
FROM revision_data
JOIN "ServiceCatalog" catalog ON catalog."code" = revision_data."code";

COMMIT;
