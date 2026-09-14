import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  await prepareServiceCatalogV2(db);

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
        type: "incarico",
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
  process.stdout.write(
    JSON.stringify({
      practiceReadinessBrowserProvision: "ready",
      cases: cases.length,
    }) + "\n",
  );
}

void main()
  .catch(() => {
    process.stderr.write("PRACTICE_READINESS_BROWSER_PROVISION_FAILED\n");
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
