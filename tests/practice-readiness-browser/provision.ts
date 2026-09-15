import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  assertAiOrchestratorEphemeralDatabaseIdentity,
  assertAiOrchestratorEphemeralDbTestConfiguration,
} from "../db/ai-orchestrator-db-test-guard";
import { prepareServiceCatalogV2 } from "../../src/lib/service-catalog-v2-persistence";
import { cases } from "./fixtures";

const db = new PrismaClient();
const password = process.env.PRACTICE_READINESS_BROWSER_PASSWORD;
const evidenceDir = process.env.PRACTICE_READINESS_BROWSER_EVIDENCE_DIR;
type ProvisionPhase = "ENVIRONMENT" | "IDENTITY" | "CATALOG" | "ACTORS" | "CASES" | "COMPLETE";
let phase: ProvisionPhase = "ENVIRONMENT";

function writeDiagnostic(status: "PASS" | "FAIL", code: string) {
  if (!evidenceDir) return;
  writeFileSync(
    join(evidenceDir, "provision-status.json"),
    `${JSON.stringify({ phase, status, code, synthetic: true })}\n`,
    { mode: 0o600 },
  );
}

async function main() {
  assert.equal(process.env.PRACTICE_READINESS_BROWSER_CONFIRMED, "1");
  assert.ok(password && password.length >= 24);
  assert.equal(
    assertAiOrchestratorEphemeralDbTestConfiguration({
      requested: process.env.RUN_DB_TESTS === "1",
      destructiveConfirmed:
        process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === "1",
      databaseUrl: process.env.DATABASE_URL,
      sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
      appEnvironment: process.env.APP_ENV,
      nodeEnvironment: process.env.NODE_ENV,
    }),
    true,
  );
  phase = "IDENTITY";
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  phase = "CATALOG";
  await prepareServiceCatalogV2(db);

  phase = "ACTORS";
  const passwordHash = await bcrypt.hash(password, 12);
  await db.user.createMany({
    data: [
      {
        id: "readiness-browser-owner",
        email: "readiness-owner@invalid.test",
        name: "Responsabile Pratiche",
        passwordHash,
        role: "direzione",
      },
      {
        id: "readiness-browser-reader",
        email: "readiness-reader@invalid.test",
        name: "Lettore Pratiche",
        passwordHash,
        role: "revisore",
      },
      {
        id: "readiness-browser-foreign",
        email: "readiness-foreign@invalid.test",
        name: "Consulente Estraneo",
        passwordHash,
        role: "consulente",
      },
    ],
  });
  await db.userPermissionOverride.create({
    data: {
      userId: "readiness-browser-owner",
      permission: "document.sensitive.read",
      allowed: false,
    },
  });

  phase = "CASES";
  for (const item of cases) {
    const catalogRevision = await db.serviceCatalogRevision.findFirstOrThrow({
      where: {
        serviceCatalog: { code: item.serviceCode },
        status: "PUBLISHED",
      },
      include: { serviceCatalog: true },
      orderBy: { version: "desc" },
    });
    const taxable = catalogRevision.netPrice ?? new Prisma.Decimal("100.00");
    const vat = taxable
      .mul(catalogRevision.vatRateBps)
      .div(10_000)
      .toDecimalPlaces(2);
    const total = taxable.add(vat);
    const client = await db.client.create({
      data: {
        id: `readiness-browser-client-${item.key}`,
        type: item.clientType,
        displayName: `Cliente ${item.label}`,
        consultantId: "readiness-browser-owner",
      },
    });
    const project = await db.project.create({
      data: {
        id: `readiness-browser-project-${item.key}`,
        clientId: client.id,
        title: `Pratica ${item.label}`,
        consultantId: "readiness-browser-owner",
      },
    });
    const lead = await db.lead.create({
      data: {
        id: `readiness-browser-lead-${item.key}`,
        firstName: "Test",
        lastName: item.label,
        clientId: client.id,
        assignedToId: "readiness-browser-owner",
      },
    });
    const intake = await db.controlledIntake.create({
      data: {
        id: randomUUID(),
        channel: "EMAIL",
        sourceId: `browser-${item.key}`,
        sourceOccurredAt: new Date(),
        acquisitionMode: "MANUAL_CONTROLLED",
        mappingVersion: "readiness-browser-v1",
        payloadHash: createHash("sha256").update(item.key).digest("hex"),
        leadId: lead.id,
        subjectType:
          item.clientType === "soggetto_da_costituire"
            ? "SOGGETTO_DA_COSTITUIRE"
            : item.clientType === "societa"
              ? "IMPRESA"
              : "PERSONA",
        firstName: "Test",
        lastName: item.label,
        classificationState: "VERIFIED",
        effectiveCategory: item.key === "forming" ? "digitale" : "consulenza",
        need: `Richiesta ${item.label}`,
        operatorId: "readiness-browser-owner",
      },
    });
    const offer = await db.commercialOffer.create({
      data: {
        id: `readiness-browser-offer-${item.key}`,
        leadId: lead.id,
        clientId: client.id,
        title: `Preventivo ${item.label}`,
        taxableAmount: taxable,
        vatAmount: vat,
        totalAmount: total,
        status: "accettata",
        acceptedAt: new Date(),
        validUntil: new Date(Date.now() + 86_400_000),
        createdById: "readiness-browser-owner",
      },
    });
    const document = await db.document.create({
      data: {
        id: `readiness-browser-document-${item.key}`,
        clientId: client.id,
        projectId: project.id,
        type: "documento_operativo",
        title: `Incarico ${item.label}`,
        fileName: `${item.key}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 10,
        storagePath: `synthetic/readiness/${item.key}.pdf`,
        uploadedById: "readiness-browser-owner",
        status: "verificato",
        checksum: createHash("sha256")
          .update(`document-${item.key}`)
          .digest("hex"),
      },
    });
    await db.documentVersion.create({
      data: {
        documentId: document.id,
        version: 1,
        storagePath: document.storagePath,
        checksum: document.checksum,
      },
    });
    const sensitiveDocument = await db.document.create({
      data: {
        id: `readiness-browser-sensitive-document-${item.key}`,
        clientId: client.id,
        projectId: project.id,
        type: "incarico",
        title: `Documento sensibile ${item.label}`,
        fileName: `sensitive-${item.key}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 10,
        storagePath: `synthetic/readiness/sensitive-${item.key}.pdf`,
        uploadedById: "readiness-browser-owner",
        status: "verificato",
        containsSensitiveData: true,
        checksum: createHash("sha256")
          .update(`sensitive-document-${item.key}`)
          .digest("hex"),
      },
    });
    await db.documentVersion.create({
      data: {
        documentId: sensitiveDocument.id,
        version: 1,
        storagePath: sensitiveDocument.storagePath,
        checksum: sensitiveDocument.checksum,
      },
    });
    const contract = await db.contract.create({
      data: {
        id: `readiness-browser-contract-${item.key}`,
        clientId: client.id,
        projectId: project.id,
        contractNumber: `BROWSER-${item.key}`,
        serviceName: catalogRevision.serviceCatalog.name,
        taxableAmount: taxable,
        vatAmount: vat,
        totalAmount: total,
        status: "firmato",
        signedAt: new Date(),
        signedDocumentId: document.id,
      },
    });
    await db.documentChecklistItem.create({
      data: {
        id: `readiness-browser-checklist-${item.key}`,
        clientId: client.id,
        projectId: project.id,
        title: `Materiale ${item.label}`,
        documentId: document.id,
        createdById: "readiness-browser-owner",
      },
    });
    await db.clientService.create({
      data: {
        id: `readiness-browser-service-${item.key}`,
        clientId: client.id,
        projectId: project.id,
        serviceCatalogId: catalogRevision.serviceCatalogId,
        contractId: contract.id,
        status: "richiesto",
        operationalStatus: "nuova",
      },
    });
    assert.equal(await db.company.count({ where: { clientId: client.id } }), 0);
    assert.ok(intake.id && offer.id);
  }
  const historicalCatalogRevision =
    await db.serviceCatalogRevision.findFirstOrThrow({
      where: {
        serviceCatalog: { code: cases[0].serviceCode },
        status: "PUBLISHED",
      },
      orderBy: { version: "desc" },
    });
  const historicalClient = await db.client.create({
    data: {
      id: "readiness-browser-client-sensitive-history",
      type: "persona_fisica",
      displayName: "Cliente storico riservato",
      consultantId: "readiness-browser-owner",
    },
  });
  const historicalProject = await db.project.create({
    data: {
      id: "readiness-browser-project-sensitive-history",
      clientId: historicalClient.id,
      title: "Pratica storica riservata",
      consultantId: "readiness-browser-owner",
    },
  });
  const historicalLead = await db.lead.create({
    data: {
      id: "readiness-browser-lead-sensitive-history",
      firstName: "Test",
      lastName: "Storico riservato",
      clientId: historicalClient.id,
      assignedToId: "readiness-browser-owner",
    },
  });
  const historicalIntake = await db.controlledIntake.create({
    data: {
      id: randomUUID(),
      channel: "EMAIL",
      sourceId: "browser-sensitive-history",
      sourceOccurredAt: new Date(),
      acquisitionMode: "MANUAL_CONTROLLED",
      mappingVersion: "readiness-browser-v1",
      payloadHash: createHash("sha256")
        .update("sensitive-history-intake")
        .digest("hex"),
      leadId: historicalLead.id,
      subjectType: "PERSONA",
      firstName: "Test",
      lastName: "Storico riservato",
      classificationState: "VERIFIED",
      effectiveCategory: "consulenza",
      need: "Richiesta storica riservata",
      operatorId: "readiness-browser-owner",
    },
  });
  const historicalOffer = await db.commercialOffer.create({
    data: {
      id: "readiness-browser-sensitive-history-offer",
      leadId: historicalLead.id,
      clientId: historicalClient.id,
      title: "Preventivo storico riservato",
      taxableAmount: "100.00",
      vatAmount: "22.00",
      totalAmount: "122.00",
      status: "accettata",
      acceptedAt: new Date(),
      validUntil: new Date(Date.now() + 86_400_000),
      createdById: "readiness-browser-owner",
    },
  });
  const historicalRevisionId = randomUUID();
  const historicalRevision = await db.practiceOfferRevision.create({
    data: {
      id: historicalRevisionId,
      controlledIntakeId: historicalIntake.id,
      commercialOfferId: historicalOffer.id,
      revision: 1,
      serviceRevisionId: historicalCatalogRevision.id,
      clientId: historicalClient.id,
      projectId: historicalProject.id,
      scope: "Perimetro storico riservato",
      inclusions: [],
      exclusions: [],
      deliverables: [],
      taxableAmount: "100.00",
      vatAmount: "22.00",
      totalAmount: "122.00",
      requiredInitialAmount: "50.00",
      currency: "EUR",
      validUntil: historicalOffer.validUntil!,
      startupConditions: "Storico riservato",
      payloadHash: createHash("sha256")
        .update("sensitive-history-revision")
        .digest("hex"),
      proposedById: "readiness-browser-owner",
    },
  });
  await db.practiceOfferAcceptance.create({
    data: {
      offerRevisionId: historicalRevision.id,
      acceptedAt: new Date(),
      acceptedById: "readiness-browser-owner",
      evidenceHash: createHash("sha256")
        .update("sensitive-history-acceptance")
        .digest("hex"),
    },
  });
  const historicalPractice = await db.practiceReadiness.create({
    data: {
      id: randomUUID(),
      controlledIntakeId: historicalIntake.id,
      commercialOfferId: historicalOffer.id,
      offerSnapshotHash: historicalRevision.payloadHash,
      offerRevision: historicalRevision.revision,
      acceptedOfferRevisionId: historicalRevision.id,
      serviceRevisionId: historicalCatalogRevision.id,
      clientId: historicalClient.id,
      projectId: historicalProject.id,
      requiredInitialAmount: "50.00",
    },
  });
  const historicalSensitiveDocument = await db.document.create({
    data: {
      id: "readiness-browser-sensitive-history-document",
      clientId: historicalClient.id,
      projectId: historicalProject.id,
      type: "incarico",
      title: "Documento storico strettamente riservato",
      fileName: "sensitive-history.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      storagePath: "synthetic/readiness/sensitive-history.pdf",
      uploadedById: "readiness-browser-owner",
      status: "verificato",
      containsSensitiveData: true,
      checksum: createHash("sha256")
        .update("sensitive-history-document")
        .digest("hex"),
    },
  });
  const historicalChecklist = await db.documentChecklistItem.create({
    data: {
      id: "readiness-browser-sensitive-history-checklist",
      clientId: historicalClient.id,
      projectId: historicalProject.id,
      title: "Requisito storico strettamente riservato",
      documentId: historicalSensitiveDocument.id,
      createdById: "readiness-browser-owner",
    },
  });
  await db.practiceMaterialEvidence.create({
    data: {
      practiceId: historicalPractice.id,
      checklistItemId: historicalChecklist.id,
      documentId: null,
      documentVersionId: null,
      documentChecksum: null,
      sequence: 1,
      status: "NOT_NEEDED",
      reason: "Motivazione storica strettamente riservata",
      payloadHash: createHash("sha256")
        .update("sensitive-history-material")
        .digest("hex"),
      decidedAt: new Date(),
      decidedById: "readiness-browser-owner",
    },
  });
  phase = "COMPLETE";
  writeDiagnostic("PASS", "PROVISION_COMPLETE");
  process.stdout.write(
    JSON.stringify({
      practiceReadinessBrowserProvision: "ready",
      cases: cases.length,
    }) + "\n",
  );
}

void main()
  .catch(() => {
    const code = `${phase}_FAILED`;
    writeDiagnostic("FAIL", code);
    process.stderr.write(`PRACTICE_READINESS_BROWSER_PROVISION_FAILED:${code}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
