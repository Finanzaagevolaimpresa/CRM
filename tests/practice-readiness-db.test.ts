import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  attestPracticeMaterialsComplete,
  createPracticeReadiness,
  proposePracticeOfferRevision,
  decidePracticeMaterial,
  formalizePractice,
  listAccessiblePracticeReadiness,
  linkPracticeClientService,
  PracticeReadinessError,
  recordPracticeFunding,
  confirmPracticeFunding,
  reversePracticeFunding,
  currentAvailableFunding,
  startPractice,
} from "../src/lib/practice-readiness";
import { prepareServiceCatalogV2 } from "../src/lib/service-catalog-v2-persistence";
import {
  authorizeEngagementDossierDelivery,
  createEngagementDossier,
  EngagementDossierError,
  exportApprovedEngagementDossier,
  recordEngagementDossierDelivery,
  reviewEngagementDossierVersion,
  reviseEngagementDossier,
} from "../src/lib/engagement-dossier";
import {
  assertAiOrchestratorEphemeralDatabaseIdentity,
  assertAiOrchestratorEphemeralDbTestConfiguration,
} from "./db/ai-orchestrator-db-test-guard";

const enabled = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === "1",
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === "1",
  databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV,
  nodeEnvironment: process.env.NODE_ENV,
});
const db = new PrismaClient();
const suffix = randomUUID();
const ids = {
  userA: `readiness-a-${suffix}`,
  userB: `readiness-b-${suffix}`,
  manager: `readiness-manager-${suffix}`,
  sessionA: randomUUID(),
  sessionB: randomUUID(),
  managerSession: randomUUID(),
};
const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
const actorA = {
  userId: ids.userA,
  sessionId: ids.sessionA,
  expiresAt,
  role: "consulente" as const,
  active: true,
  permissionOverrides: [],
};
const actorB = {
  userId: ids.userB,
  sessionId: ids.sessionB,
  expiresAt,
  role: "consulente" as const,
  active: true,
  permissionOverrides: [],
};
const manager = {
  userId: ids.manager,
  sessionId: ids.managerSession,
  expiresAt,
  role: "direzione" as const,
  active: true,
  permissionOverrides: [],
};
const previousMode = process.env.PRACTICE_READINESS_MODE;

type Context = Awaited<ReturnType<typeof createContext>>;
let a: Context;
let b: Context;
let revisionId: string;
let serviceCatalogId: string;
let emptyAttestationAHash: string;
let offerAmounts = { taxable: "100.00", vat: "22.00", total: "122.00" };

function denied(error: unknown) {
  return error instanceof PracticeReadinessError && error.code === "DENIED";
}

async function createContext(label: string, consultantId: string) {
  const client = await db.client.create({
    data: {
      type: "persona_fisica",
      displayName: `Cliente sintetico ${label} ${suffix}`,
      consultantId,
    },
  });
  const project = await db.project.create({
    data: {
      clientId: client.id,
      title: `Pratica sintetica ${label} ${suffix}`,
      consultantId,
    },
  });
  const lead = await db.lead.create({
    data: {
      firstName: "Test",
      lastName: `Ambito ${label}`,
      clientId: client.id,
      assignedToId: consultantId,
    },
  });
  const intake = await db.controlledIntake.create({
    data: {
      channel: "EMAIL",
      sourceId: `scope-${label}-${suffix}`,
      sourceOccurredAt: new Date(),
      acquisitionMode: "MANUAL_CONTROLLED",
      mappingVersion: "scope-test-v1",
      payloadHash: randomBytes(32).toString("hex"),
      leadId: lead.id,
      subjectType: "PERSONA",
      firstName: "Test",
      lastName: `Ambito ${label}`,
      classificationState: "VERIFIED",
      effectiveCategory: "digitale",
      need: "Fixture sintetica di ambito",
      operatorId: consultantId,
    },
  });
  const offer = await db.commercialOffer.create({
    data: {
      leadId: lead.id,
      clientId: client.id,
      title: `Preventivo ${label}`,
      taxableAmount: offerAmounts.taxable,
      vatAmount: offerAmounts.vat,
      totalAmount: offerAmounts.total,
      status: "accettata",
      acceptedAt: new Date(),
      validUntil: new Date(Date.now() + 86_400_000),
      createdById: consultantId,
    },
  });
  const document = await db.document.create({
    data: {
      clientId: client.id,
      projectId: project.id,
      type: "documento_operativo",
      title: `Incarico ${label}`,
      fileName: `${label}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 10,
      storagePath: `synthetic/${suffix}/${label}.pdf`,
      uploadedById: consultantId,
      status: "verificato",
      checksum: randomBytes(32).toString("hex"),
    },
  });
  const documentVersion = await db.documentVersion.create({
    data: {
      documentId: document.id,
      version: 1,
      storagePath: document.storagePath,
      checksum: document.checksum,
    },
  });
  const contract = await db.contract.create({
    data: {
      clientId: client.id,
      projectId: project.id,
      contractNumber: `SCOPE-${label}-${suffix}`,
      serviceName: "Servizio sintetico",
      taxableAmount: offerAmounts.taxable,
      vatAmount: offerAmounts.vat,
      totalAmount: offerAmounts.total,
      status: "firmato",
      signedAt: new Date(),
      signedDocumentId: document.id,
    },
  });
  const checklist = await db.documentChecklistItem.create({
    data: {
      clientId: client.id,
      projectId: project.id,
      documentId: document.id,
      title: `Materiale ${label}`,
      createdById: consultantId,
    },
  });
  const clientService = await db.clientService.create({
    data: {
      clientId: client.id,
      projectId: project.id,
      serviceCatalogId,
      contractId: contract.id,
      status: "richiesto",
      operationalStatus: "nuova",
    },
  });
  return {
    client,
    project,
    lead,
    intake,
    offer,
    document,
    documentVersion,
    contract,
    checklist,
    clientService,
  };
}

async function createPractice(context: Context, actor: typeof actorA) {
  const revision = await proposePracticeOfferRevision(db, actor, {
    controlledIntakeId: context.intake.id,
    commercialOfferId: context.offer.id,
    serviceRevisionId: revisionId,
    clientId: context.client.id,
    projectId: context.project.id,
    digitalProjectType: "software_crm_workflow",
    scope: "Perimetro sintetico verificabile",
    startupConditions: "Acconto e materiali verificati",
    requiredInitialAmount: "50.00",
    expectedOfferUpdatedAt: context.offer.updatedAt,
  });
  return createPracticeReadiness(db, actor, { offerRevisionId: revision.id });
}

async function ensurePractice(context: Context, actor: typeof actorA) {
  return (
    (await db.practiceReadiness.findUnique({
      where: { controlledIntakeId: context.intake.id },
    })) ?? createPractice(context, actor)
  );
}

async function footprint(practiceId: string) {
  const [
    practice,
    funding,
    materials,
    formalizations,
    clientService,
    audits,
    totalPractices,
  ] = await Promise.all([
    db.practiceReadiness.findUnique({ where: { id: practiceId } }),
    db.practiceFundingEvidence.count({ where: { practiceId } }),
    db.practiceMaterialEvidence.count({ where: { practiceId } }),
    db.practiceFormalization.count({ where: { practiceId } }),
    db.practiceReadiness
      .findUnique({
        where: { id: practiceId },
        select: { clientServiceId: true },
      })
      .then((row) =>
        row?.clientServiceId
          ? db.clientService.findUnique({ where: { id: row.clientServiceId } })
          : null,
      ),
    db.auditLog.count({
      where: { entityType: "PracticeReadiness", entityId: practiceId },
    }),
    db.practiceReadiness.count(),
  ]);
  return {
    practice,
    funding,
    materials,
    formalizations,
    clientService,
    audits,
    totalPractices,
  };
}

async function globalFootprint() {
  const [practices, funding, materials, audits] = await Promise.all([
    db.practiceReadiness.count(),
    db.practiceFundingEvidence.count(),
    db.practiceMaterialEvidence.count(),
    db.auditLog.count({
      where: { actorId: { in: [ids.userA, ids.userB, ids.manager] } },
    }),
  ]);
  return { practices, funding, materials, audits };
}

async function expectDeniedWithoutEffects(
  practiceId: string,
  operation: () => Promise<unknown>,
) {
  const before = await footprint(practiceId);
  await assert.rejects(operation, denied);
  assert.deepEqual(await footprint(practiceId), before);
}

test.before(async () => {
  if (!enabled) return;
  // This identity check intentionally precedes every fixture/catalog write.
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  process.env.PRACTICE_READINESS_MODE = "synthetic";
  await prepareServiceCatalogV2(db);
  await db.user.createMany({
    data: [
      {
        id: ids.userA,
        email: `${ids.userA}@invalid.test`,
        name: "Consulente A",
        passwordHash: "synthetic",
        role: "consulente",
      },
      {
        id: ids.userB,
        email: `${ids.userB}@invalid.test`,
        name: "Consulente B",
        passwordHash: "synthetic",
        role: "consulente",
      },
      {
        id: ids.manager,
        email: `${ids.manager}@invalid.test`,
        name: "Direzione sintetica",
        passwordHash: "synthetic",
        role: "direzione",
      },
    ],
  });
  await db.internalSession.createMany({
    data: [
      {
        id: ids.sessionA,
        userId: ids.userA,
        tokenDigest: randomBytes(32),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      {
        id: ids.sessionB,
        userId: ids.userB,
        tokenDigest: randomBytes(32),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      {
        id: ids.managerSession,
        userId: ids.manager,
        tokenDigest: randomBytes(32),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    ],
  });
  const revision = await db.serviceCatalogRevision.findFirstOrThrow({
    where: {
      serviceCatalog: { code: "progetti_digitali" },
      status: "PUBLISHED",
    },
    orderBy: { version: "desc" },
  });
  revisionId = revision.id;
  serviceCatalogId = revision.serviceCatalogId;
  const taxable = revision.netPrice ?? new Prisma.Decimal("100.00");
  const vat = taxable.mul(revision.vatRateBps).div(10_000).toDecimalPlaces(2);
  offerAmounts = {
    taxable: taxable.toFixed(2),
    vat: vat.toFixed(2),
    total: taxable.add(vat).toFixed(2),
  };
  a = await createContext("A", ids.userA);
  b = await createContext("B", ids.userB);
});

test.after(async () => {
  if (enabled) {
    const engagementDossiers = await db.clientDossier.findMany({ where: { clientId: { in: [a.client.id, b.client.id] } }, select: { id: true } });
    const engagementDossierIds = engagementDossiers.map((row) => row.id);
    const authorizations = await db.engagementDossierDeliveryAuthorization.findMany({ where: { dossierId: { in: engagementDossierIds } }, select: { id: true } });
    await db.engagementDossierDeliveryReceipt.deleteMany({ where: { authorizationId: { in: authorizations.map((row) => row.id) } } });
    await db.engagementDossierDeliveryAuthorization.deleteMany({ where: { dossierId: { in: engagementDossierIds } } });
    await db.engagementDossierExport.deleteMany({ where: { dossierId: { in: engagementDossierIds } } });
    await db.engagementDossierReview.deleteMany({ where: { dossierId: { in: engagementDossierIds } } });
    await db.clientDossier.updateMany({ where: { id: { in: engagementDossierIds } }, data: { currentVersionId: null, approvedVersionId: null } });
    await db.engagementDossierVersion.deleteMany({ where: { dossierId: { in: engagementDossierIds } } });
    await db.clientDossier.deleteMany({ where: { id: { in: engagementDossierIds } } });
    await db.preAnalysis.deleteMany({ where: { clientId: { in: [a.client.id, b.client.id] } } });
    await db.practiceMaterialEvidence.deleteMany({
      where: { practice: { clientId: { in: [a.client.id, b.client.id] } } },
    });
    await db.practiceFundingEvidence.deleteMany({
      where: { practice: { clientId: { in: [a.client.id, b.client.id] } } },
    });
    await db.practiceReadiness.updateMany({
      where: { clientId: { in: [a.client.id, b.client.id] } },
      data: { materialsCompleteEvidenceId: null, currentFormalizationId: null },
    });
    await db.practiceFormalization.deleteMany({
      where: { practice: { clientId: { in: [a.client.id, b.client.id] } } },
    });
    await db.practiceMaterialAttestation.deleteMany({
      where: { practice: { clientId: { in: [a.client.id, b.client.id] } } },
    });
    await db.practiceReadiness.deleteMany({
      where: { clientId: { in: [a.client.id, b.client.id] } },
    });
    const revisionRows = await db.practiceOfferRevision.findMany({
      where: { clientId: { in: [a.client.id, b.client.id] } },
      select: { id: true },
    });
    await db.practiceOfferAcceptance.deleteMany({
      where: { offerRevisionId: { in: revisionRows.map((row) => row.id) } },
    });
    await db.practiceOfferRevision.deleteMany({
      where: { id: { in: revisionRows.map((row) => row.id) } },
    });
    await db.documentChecklistItem.deleteMany({
      where: { clientId: { in: [a.client.id, b.client.id] } },
    });
    await db.clientService.deleteMany({
      where: { clientId: { in: [a.client.id, b.client.id] } },
    });
    await db.contract.deleteMany({
      where: { clientId: { in: [a.client.id, b.client.id] } },
    });
    const cleanupDocuments = await db.document.findMany({
      where: { clientId: { in: [a.client.id, b.client.id] } },
      select: { id: true },
    });
    await db.documentVersion.deleteMany({
      where: { documentId: { in: cleanupDocuments.map((row) => row.id) } },
    });
    await db.document.deleteMany({
      where: { clientId: { in: [a.client.id, b.client.id] } },
    });
    await db.controlledIntake.deleteMany({
      where: { id: { in: [a.intake.id, b.intake.id] } },
    });
    await db.commercialOffer.deleteMany({
      where: { clientId: { in: [a.client.id, b.client.id] } },
    });
    await db.project.deleteMany({
      where: { clientId: { in: [a.client.id, b.client.id] } },
    });
    await db.lead.deleteMany({ where: { id: { in: [a.lead.id, b.lead.id] } } });
    await db.client.deleteMany({
      where: { id: { in: [a.client.id, b.client.id] } },
    });
    await db.auditLog.deleteMany({
      where: { actorId: { in: [ids.userA, ids.userB, ids.manager] } },
    });
    await db.internalSession.deleteMany({
      where: { id: { in: [ids.sessionA, ids.sessionB, ids.managerSession] } },
    });
    await db.user.deleteMany({
      where: { id: { in: [ids.userA, ids.userB, ids.manager] } },
    });
  }
  if (previousMode === undefined) delete process.env.PRACTICE_READINESS_MODE;
  else process.env.PRACTICE_READINESS_MODE = previousMode;
  await db.$disconnect();
});

test(
  "scope read model exposes A and omits B for a service.write operator",
  { skip: !enabled },
  async () => {
    const practiceA = await ensurePractice(a, actorA);
    const practiceB = await ensurePractice(b, actorB);
    const visible = await listAccessiblePracticeReadiness(db, actorA);
    assert.equal(
      visible.some(({ id }) => id === practiceA.id),
      true,
    );
    assert.equal(
      visible.some(({ id }) => id === practiceB.id),
      false,
    );
  },
);

test(
  "accepted offer revision stays immutable when a later proposal is created",
  { skip: !enabled },
  async () => {
    let practice = await ensurePractice(a, actorA);
    const accepted = await db.practiceOfferRevision.findUniqueOrThrow({
      where: { id: practice.acceptedOfferRevisionId },
      include: { acceptance: true },
    });
    assert.ok(accepted.acceptance);
    const emptyReason = "Nessun materiale applicabile alla fase sintetica";
    await db.documentChecklistItem.update({
      where: { id: a.checklist.id },
      data: { active: false },
    });
    const firstAttested = await attestPracticeMaterialsComplete(db, actorA, {
      practiceId: practice.id,
      expectedVersion: practice.version,
      emptyChecklistReason: emptyReason,
    });
    const firstEvidenceId = firstAttested.materialsCompleteEvidenceId;
    assert.ok(firstEvidenceId);
    emptyAttestationAHash = (
      await db.practiceMaterialAttestation.findUniqueOrThrow({
        where: { id: firstEvidenceId },
      })
    ).snapshotHash;
    const attestationCount = await db.practiceMaterialAttestation.count({
      where: { practiceId: practice.id },
    });
    const auditCount = await db.auditLog.count({
      where: { entityType: "PracticeReadiness", entityId: practice.id },
    });
    const replayed = await attestPracticeMaterialsComplete(db, actorA, {
      practiceId: practice.id,
      expectedVersion: firstAttested.version,
      emptyChecklistReason: emptyReason,
    });
    assert.equal(replayed.version, firstAttested.version);
    assert.equal(replayed.materialsCompleteEvidenceId, firstEvidenceId);
    assert.equal(
      await db.practiceMaterialAttestation.count({
        where: { practiceId: practice.id },
      }),
      attestationCount,
    );
    assert.equal(
      await db.auditLog.count({
        where: { entityType: "PracticeReadiness", entityId: practice.id },
      }),
      auditCount,
    );
    await db.documentChecklistItem.update({
      where: { id: a.checklist.id },
      data: { active: true },
    });
    practice = replayed;
    process.env.PRACTICE_READINESS_TEST_FAIL_AUDIT = "1";
    try {
      await assert.rejects(
        formalizePractice(db, actorA, {
          practiceId: practice.id,
          contractId: a.contract.id,
          signedDocumentId: a.document.id,
          signedDocumentVersionId: a.documentVersion.id,
          expectedVersion: practice.version,
        }),
        (error) =>
          error instanceof PracticeReadinessError && error.code === "CONFLICT",
      );
    } finally {
      delete process.env.PRACTICE_READINESS_TEST_FAIL_AUDIT;
    }
    assert.equal(
      await db.practiceFormalization.count({
        where: { practiceId: practice.id },
      }),
      0,
    );
    const firstFormalized = await formalizePractice(db, actorA, {
      practiceId: practice.id,
      contractId: a.contract.id,
      signedDocumentId: a.document.id,
      signedDocumentVersionId: a.documentVersion.id,
      expectedVersion: practice.version,
    });
    const firstFormalizationId = firstFormalized.currentFormalizationId;
    assert.ok(firstFormalizationId);
    await db.commercialOffer.update({
      where: { id: a.offer.id },
      data: { description: "Seconda proposta sintetica distinta" },
    });
    const currentOffer = await db.commercialOffer.findUniqueOrThrow({
      where: { id: a.offer.id },
    });
    const second = await proposePracticeOfferRevision(db, actorA, {
      controlledIntakeId: a.intake.id,
      commercialOfferId: a.offer.id,
      serviceRevisionId: revisionId,
      clientId: a.client.id,
      projectId: a.project.id,
      digitalProjectType: "software_crm_workflow",
      scope: "Secondo perimetro sintetico",
      startupConditions: "Nuove condizioni da accettare",
      requiredInitialAmount: "50.00",
      expectedOfferUpdatedAt: currentOffer.updatedAt,
    });
    assert.equal(second.revision, accepted.revision + 1);
    assert.notEqual(second.payloadHash, accepted.payloadHash);
    assert.equal(
      await db.practiceOfferAcceptance.count({
        where: { offerRevisionId: second.id },
      }),
      0,
    );
    let revisedPractice = await createPracticeReadiness(db, actorA, {
      offerRevisionId: second.id,
    });
    assert.equal(revisedPractice.id, practice.id);
    assert.equal(revisedPractice.acceptedOfferRevisionId, second.id);
    const unchanged = await db.practiceOfferRevision.findUniqueOrThrow({
      where: { id: accepted.id },
      include: { acceptance: true },
    });
    assert.equal(unchanged.payloadHash, accepted.payloadHash);
    assert.equal(
      unchanged.acceptance?.evidenceHash,
      accepted.acceptance?.evidenceHash,
    );
    assert.ok(
      await db.practiceOfferAcceptance.findUnique({
        where: { offerRevisionId: second.id },
      }),
    );
    assert.equal(revisedPractice.currentFormalizationId, null);
    await db.documentChecklistItem.update({
      where: { id: a.checklist.id },
      data: { active: false },
    });
    revisedPractice = await attestPracticeMaterialsComplete(db, actorA, {
      practiceId: practice.id,
      expectedVersion: revisedPractice.version,
      emptyChecklistReason: emptyReason,
    });
    assert.notEqual(revisedPractice.materialsCompleteEvidenceId, firstEvidenceId);
    assert.equal(
      await db.practiceMaterialAttestation.count({
        where: { practiceId: practice.id },
      }),
      attestationCount + 1,
    );
    await db.documentChecklistItem.update({
      where: { id: a.checklist.id },
      data: { active: true },
    });
    assert.ok(
      await db.practiceFormalization.findUnique({
        where: { id: firstFormalizationId },
      }),
    );
    const secondFormalized = await formalizePractice(db, actorA, {
      practiceId: practice.id,
      contractId: a.contract.id,
      signedDocumentId: a.document.id,
      signedDocumentVersionId: a.documentVersion.id,
      expectedVersion: revisedPractice.version,
    });
    assert.notEqual(
      secondFormalized.currentFormalizationId,
      firstFormalizationId,
    );
    const formalizationHistory = await db.practiceFormalization.findMany({
      where: { practiceId: practice.id },
      orderBy: { formalizedAt: "asc" },
    });
    assert.deepEqual(
      formalizationHistory.map((row) => row.offerRevisionId),
      [accepted.id, second.id],
    );

    await db.commercialOffer.update({
      where: { id: a.offer.id },
      data: { description: "Terza proposta sintetica" },
    });
    const thirdOffer = await db.commercialOffer.findUniqueOrThrow({
      where: { id: a.offer.id },
    });
    const third = await proposePracticeOfferRevision(db, actorA, {
      controlledIntakeId: a.intake.id,
      commercialOfferId: a.offer.id,
      serviceRevisionId: revisionId,
      clientId: a.client.id,
      projectId: a.project.id,
      digitalProjectType: "software_crm_workflow",
      scope: "Terzo perimetro",
      startupConditions: "Da accettare",
      requiredInitialAmount: "50.00",
      expectedOfferUpdatedAt: thirdOffer.updatedAt,
    });
    await db.serviceCatalogRevision.update({
      where: { id: revisionId },
      data: { status: "RETIRED", retiredAt: new Date() },
    });
    try {
      await assert.rejects(
        createPracticeReadiness(db, actorA, { offerRevisionId: third.id }),
        denied,
      );
    } finally {
      await db.serviceCatalogRevision.update({
        where: { id: revisionId },
        data: { status: "PUBLISHED", retiredAt: null },
      });
    }
    assert.equal(
      await db.practiceOfferAcceptance.count({
        where: { offerRevisionId: third.id },
      }),
      0,
    );
  },
);

test(
  "expired offer cannot produce a revision and leaves no audit or proposal",
  { skip: !enabled },
  async () => {
    const before = await globalFootprint();
    const current = await db.commercialOffer.update({
      where: { id: b.offer.id },
      data: { validUntil: new Date(Date.now() - 1_000) },
    });
    await assert.rejects(
      proposePracticeOfferRevision(db, actorB, {
        controlledIntakeId: b.intake.id,
        commercialOfferId: b.offer.id,
        serviceRevisionId: revisionId,
        clientId: b.client.id,
        projectId: b.project.id,
        digitalProjectType: "software_crm_workflow",
        scope: "Offerta scaduta",
        startupConditions: "Non applicabili",
        requiredInitialAmount: "50.00",
        expectedOfferUpdatedAt: current.updatedAt,
      }),
      denied,
    );
    assert.deepEqual(await globalFootprint(), before);
    b.offer = await db.commercialOffer.update({
      where: { id: b.offer.id },
      data: { validUntil: new Date(Date.now() + 86_400_000) },
    });
    const proposalsBefore = await db.practiceOfferRevision.count({
      where: { commercialOfferId: b.offer.id },
    });
    process.env.PRACTICE_READINESS_TEST_FAIL_AUDIT = "1";
    try {
      await assert.rejects(
        proposePracticeOfferRevision(db, actorB, {
          controlledIntakeId: b.intake.id,
          commercialOfferId: b.offer.id,
          serviceRevisionId: revisionId,
          clientId: b.client.id,
          projectId: b.project.id,
          digitalProjectType: "software_crm_workflow",
          scope: "Rollback proposta",
          startupConditions: "Rollback audit",
          requiredInitialAmount: "50.00",
          expectedOfferUpdatedAt: b.offer.updatedAt,
        }),
        (error) =>
          error instanceof PracticeReadinessError && error.code === "CONFLICT",
      );
    } finally {
      delete process.env.PRACTICE_READINESS_TEST_FAIL_AUDIT;
    }
    assert.equal(
      await db.practiceOfferRevision.count({
        where: { commercialOfferId: b.offer.id },
      }),
      proposalsBefore,
    );
  },
);

test(
  "sensitive material documents require canonical document access",
  { skip: !enabled },
  async () => {
    const practice = await ensurePractice(a, actorA);
    const before = await footprint(practice.id);
    assert.ok(before.practice);
    await db.document.update({
      where: { id: a.document.id },
      data: { containsSensitiveData: true },
    });
    const ordinaryHistoryDocument = await db.document.create({
      data: {
        clientId: a.client.id,
        projectId: a.project.id,
        type: "documento_operativo",
        title: `Documento storico ordinario ${suffix}`,
        fileName: `ordinary-history-${suffix}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 10,
        storagePath: `synthetic/${suffix}/ordinary-history.pdf`,
        uploadedById: ids.manager,
        status: "verificato",
        checksum: randomBytes(32).toString("hex"),
      },
    });
    const ordinaryHistoryVersion = await db.documentVersion.create({
      data: {
        documentId: ordinaryHistoryDocument.id,
        version: 1,
        storagePath: ordinaryHistoryDocument.storagePath,
        checksum: ordinaryHistoryDocument.checksum,
      },
    });
    const mismatchedHistoryChecklist = await db.documentChecklistItem.create({
      data: {
        clientId: a.client.id,
        projectId: a.project.id,
        documentId: ordinaryHistoryDocument.id,
        title: `Requisito storico ordinario discordante ${suffix}`,
        createdById: ids.manager,
      },
    });
    const coherentHistoryChecklist = await db.documentChecklistItem.create({
      data: {
        clientId: a.client.id,
        projectId: a.project.id,
        documentId: ordinaryHistoryDocument.id,
        title: `Requisito storico ordinario coerente ${suffix}`,
        createdById: ids.manager,
      },
    });
    const mismatchedHistoryReason =
      "Motivazione storica con sola versione sensibile";
    const mismatchedHistory = await db.practiceMaterialEvidence.create({
      data: {
        practiceId: practice.id,
        checklistItemId: mismatchedHistoryChecklist.id,
        documentId: null,
        documentVersionId: a.documentVersion.id,
        documentChecksum: null,
        status: "NOT_NEEDED",
        reason: mismatchedHistoryReason,
        payloadHash: randomBytes(32).toString("hex"),
        sequence: 1,
        decidedAt: new Date(),
        decidedById: ids.manager,
      },
    });
    const coherentHistory = await db.practiceMaterialEvidence.create({
      data: {
        practiceId: practice.id,
        checklistItemId: coherentHistoryChecklist.id,
        documentId: null,
        documentVersionId: ordinaryHistoryVersion.id,
        documentChecksum: null,
        status: "NOT_NEEDED",
        reason: "Motivazione storica coerente",
        payloadHash: randomBytes(32).toString("hex"),
        sequence: 1,
        decidedAt: new Date(),
        decidedById: ids.manager,
      },
    });
    try {
      for (const status of ["NOT_NEEDED", "INVALIDATED"] as const)
        await expectDeniedWithoutEffects(practice.id, () =>
          decidePracticeMaterial(db, actorA, {
            practiceId: practice.id,
            checklistItemId: a.checklist.id,
            documentId: null,
            documentVersionId: null,
            status,
            reason: "Motivazione riservata da non esporre",
            expectedVersion: practice.version,
          }),
        );
      const beforeDeniedCompleteness = await footprint(practice.id);
      await assert.rejects(
        attestPracticeMaterialsComplete(db, actorA, {
          practiceId: practice.id,
          expectedVersion: practice.version,
        }),
        (error) =>
          error instanceof PracticeReadinessError && error.code === "NOT_READY",
      );
      assert.deepEqual(await footprint(practice.id), beforeDeniedCompleteness);
      const authorized = await decidePracticeMaterial(db, manager, {
        practiceId: practice.id,
        checklistItemId: a.checklist.id,
        documentId: null,
        documentVersionId: null,
        status: "NOT_NEEDED",
        reason: "Motivazione riservata da non esporre",
        expectedVersion: practice.version,
      });
      assert.equal(authorized.documentId, null);
      assert.equal(authorized.documentVersionId, null);
      const deniedRead = (
        await listAccessiblePracticeReadiness(db, actorA)
      ).find((row) => row.id === practice.id);
      assert.ok(deniedRead);
      assert.equal(
        deniedRead.materials.some((row) => row.id === authorized.id),
        false,
      );
      assert.equal(
        deniedRead.prerequisites.missing.includes("materiale_riservato"),
        true,
      );
      assert.equal(
        deniedRead.prerequisites.missing.some((value) =>
          value.includes(a.checklist.id),
        ),
        false,
      );
      assert.equal(JSON.stringify(deniedRead).includes(a.checklist.id), false);
      assert.equal(
        JSON.stringify(deniedRead).includes(
          "Motivazione riservata da non esporre",
        ),
        false,
      );
      assert.equal(
        deniedRead.materials.some((row) => row.id === mismatchedHistory.id),
        false,
      );
      assert.equal(
        deniedRead.materials.some((row) => row.id === coherentHistory.id),
        true,
      );
      assert.equal(
        JSON.stringify(deniedRead).includes(mismatchedHistoryReason),
        false,
      );
      assert.equal(
        deniedRead.prerequisites.missing.some((value) =>
          value.includes(mismatchedHistoryChecklist.id),
        ),
        false,
      );
      const authorizedRead = (
        await listAccessiblePracticeReadiness(db, manager)
      ).find((row) => row.id === practice.id);
      assert.equal(
        authorizedRead?.materials.some((row) => row.id === authorized.id),
        true,
      );
      assert.equal(
        authorizedRead?.materials.some(
          (row) => row.id === mismatchedHistory.id,
        ),
        false,
      );
      assert.equal(
        authorizedRead?.materials.some((row) => row.id === coherentHistory.id),
        true,
      );
    } finally {
      await db.practiceReadiness.update({
        where: { id: practice.id },
        data: {
          version: before.practice.version,
          updatedAt: before.practice.updatedAt,
          materialsCompleteAt: before.practice.materialsCompleteAt,
          materialsCompleteById: before.practice.materialsCompleteById,
          materialsCompleteEvidenceId:
            before.practice.materialsCompleteEvidenceId,
        },
      });
      await db.practiceMaterialEvidence.deleteMany({
        where: {
          practiceId: practice.id,
          checklistItemId: {
            in: [
              a.checklist.id,
              mismatchedHistoryChecklist.id,
              coherentHistoryChecklist.id,
            ],
          },
        },
      });
      await db.auditLog.deleteMany({
        where: {
          actorId: ids.manager,
          entityType: "PracticeReadiness",
          entityId: practice.id,
          event: "practice_material_decided",
        },
      });
      await db.document.update({
        where: { id: a.document.id },
        data: { containsSensitiveData: false },
      });
      await db.documentChecklistItem.deleteMany({
        where: {
          id: { in: [mismatchedHistoryChecklist.id, coherentHistoryChecklist.id] },
        },
      });
      await db.documentVersion.delete({
        where: { id: ordinaryHistoryVersion.id },
      });
      await db.document.delete({ where: { id: ordinaryHistoryDocument.id } });
    }
    assert.deepEqual(await footprint(practice.id), before);
  },
);

test(
  "every command and create replay deny a known out-of-scope B id without effects",
  { skip: !enabled },
  async () => {
    const practiceB = await ensurePractice(b, actorB);
    const commands = [
      () =>
        recordPracticeFunding(db, actorA, {
          practiceId: practiceB.id,
          reference: `B-${suffix}`,
          amount: "10.00",
          currency: "EUR",
          expectedVersion: practiceB.version,
        }),
      () =>
        confirmPracticeFunding(db, actorA, {
          practiceId: practiceB.id,
          evidenceId: randomUUID(),
          expectedVersion: practiceB.version,
        }),
      () =>
        reversePracticeFunding(db, actorA, {
          practiceId: practiceB.id,
          evidenceId: randomUUID(),
          expectedVersion: practiceB.version,
        }),
      () =>
        decidePracticeMaterial(db, actorA, {
          practiceId: practiceB.id,
          checklistItemId: b.checklist.id,
          status: "NOT_NEEDED",
          reason: "Non pertinente",
          expectedVersion: practiceB.version,
        }),
      () =>
        formalizePractice(db, actorA, {
          practiceId: practiceB.id,
          contractId: b.contract.id,
          signedDocumentId: b.document.id,
          signedDocumentVersionId: b.documentVersion.id,
          expectedVersion: practiceB.version,
        }),
      () =>
        linkPracticeClientService(db, actorA, {
          practiceId: practiceB.id,
          clientServiceId: b.clientService.id,
          expectedVersion: practiceB.version,
        }),
      () =>
        attestPracticeMaterialsComplete(db, actorA, {
          practiceId: practiceB.id,
          expectedVersion: practiceB.version,
        }),
      () =>
        startPractice(db, actorA, {
          practiceId: practiceB.id,
          expectedVersion: practiceB.version,
        }),
      () => createPractice(b, actorA),
    ];
    for (const command of commands)
      await expectDeniedWithoutEffects(practiceB.id, command);
  },
);

test(
  "create rejects nonexistent/cross-client references before persistence",
  { skip: !enabled },
  async () => {
    const before = await globalFootprint();
    await assert.rejects(
      proposePracticeOfferRevision(db, actorA, {
        controlledIntakeId: b.intake.id,
        commercialOfferId: a.offer.id,
        serviceRevisionId: revisionId,
        clientId: a.client.id,
        projectId: a.project.id,
        digitalProjectType: "software_crm_workflow",
        scope: "Scope",
        startupConditions: "Condizioni",
        requiredInitialAmount: "50.00",
        expectedOfferUpdatedAt: a.offer.updatedAt,
      }),
      denied,
    );
    await assert.rejects(
      proposePracticeOfferRevision(db, actorA, {
        controlledIntakeId: a.intake.id,
        commercialOfferId: a.offer.id,
        serviceRevisionId: revisionId,
        clientId: a.client.id,
        projectId: `missing-${suffix}`,
        digitalProjectType: "software_crm_workflow",
        scope: "Scope",
        startupConditions: "Condizioni",
        requiredInitialAmount: "50.00",
        expectedOfferUpdatedAt: a.offer.updatedAt,
      }),
      denied,
    );
    assert.deepEqual(await globalFootprint(), before);
  },
);

test(
  "revocation and changed assignment deny commands and replay with zero effects",
  { skip: !enabled },
  async () => {
    const practiceA = await ensurePractice(a, actorA);
    await db.client.update({
      where: { id: a.client.id },
      data: { consultantId: ids.userB },
    });
    await expectDeniedWithoutEffects(practiceA.id, () =>
      recordPracticeFunding(db, actorA, {
        practiceId: practiceA.id,
        reference: `REASSIGNED-${suffix}`,
        amount: "1.00",
        currency: "EUR",
        expectedVersion: practiceA.version,
      }),
    );
    await expectDeniedWithoutEffects(practiceA.id, () =>
      createPractice(a, actorA),
    );
    await db.client.update({
      where: { id: a.client.id },
      data: { consultantId: ids.userA },
    });
    await db.internalSession.update({
      where: { id: ids.sessionA },
      data: {
        revokedAt: new Date(),
        revokedReason: "INTERNAL_SINGLE",
        revokedByUserId: ids.userA,
      },
    });
    await expectDeniedWithoutEffects(practiceA.id, () =>
      startPractice(db, actorA, {
        practiceId: practiceA.id,
        expectedVersion: practiceA.version,
      }),
    );
    await expectDeniedWithoutEffects(practiceA.id, () =>
      createPractice(a, actorA),
    );
    await db.internalSession.update({
      where: { id: ids.sessionA },
      data: { revokedAt: null, revokedReason: null, revokedByUserId: null },
    });
  },
);

test(
  "archived client, lead, and project independently hide reads and deny writes",
  { skip: !enabled },
  async () => {
    const practiceA = await ensurePractice(a, actorA);
    const cases = [
      {
        archive: () =>
          db.client.update({
            where: { id: a.client.id },
            data: { deletedAt: new Date() },
          }),
        restore: () =>
          db.client.update({
            where: { id: a.client.id },
            data: { deletedAt: null },
          }),
      },
      {
        archive: () =>
          db.lead.update({
            where: { id: a.lead.id },
            data: { deletedAt: new Date() },
          }),
        restore: () =>
          db.lead.update({
            where: { id: a.lead.id },
            data: { deletedAt: null },
          }),
      },
      {
        archive: () =>
          db.project.update({
            where: { id: a.project.id },
            data: { deletedAt: new Date() },
          }),
        restore: () =>
          db.project.update({
            where: { id: a.project.id },
            data: { deletedAt: null },
          }),
      },
    ];
    for (const item of cases) {
      await item.archive();
      try {
        assert.equal(
          (await listAccessiblePracticeReadiness(db, actorA)).some(
            ({ id }) => id === practiceA.id,
          ),
          false,
        );
        await expectDeniedWithoutEffects(practiceA.id, () =>
          recordPracticeFunding(db, actorA, {
            practiceId: practiceA.id,
            reference: `ARCHIVED-${suffix}`,
            amount: "1.00",
            currency: "EUR",
            expectedVersion: practiceA.version,
          }),
        );
        await expectDeniedWithoutEffects(practiceA.id, () =>
          createPractice(a, actorA),
        );
      } finally {
        await item.restore();
      }
    }
  },
);

test(
  "funding history is exact, idempotent, concurrent-safe, reversible, and atomic",
  { skip: !enabled },
  async () => {
    let practice = await ensurePractice(b, actorB);
    const firstInput = {
      practiceId: practice.id,
      reference: `PARTIAL-1-${suffix}`,
      amount: "20.00",
      currency: "EUR",
      expectedVersion: practice.version,
    } as const;
    const declared = await recordPracticeFunding(db, actorB, firstInput);
    const replay = await recordPracticeFunding(db, actorB, firstInput);
    assert.equal(replay.id, declared.id);
    assert.equal(
      await db.practiceFundingEvidence.count({
        where: { practiceId: practice.id },
      }),
      1,
    );
    await assert.rejects(
      recordPracticeFunding(db, actorB, { ...firstInput, amount: "21.00" }),
      (error) =>
        error instanceof PracticeReadinessError && error.code === "CONFLICT",
    );
    await assert.rejects(
      recordPracticeFunding(db, actorB, {
        ...firstInput,
        reference: `STALE-${suffix}`,
      }),
      (error) =>
        error instanceof PracticeReadinessError && error.code === "CONFLICT",
    );

    practice = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    const confirmationInput = {
      practiceId: practice.id,
      evidenceId: declared.id,
      expectedVersion: practice.version,
    };
    const confirmations = await Promise.all([
      confirmPracticeFunding(db, actorB, confirmationInput),
      confirmPracticeFunding(db, actorB, confirmationInput),
    ]);
    assert.equal(confirmations[0].id, confirmations[1].id);
    let history = await db.practiceFundingEvidence.findMany({
      where: { practiceId: practice.id },
      include: { successor: true },
    });
    assert.equal(history.length, 2);
    assert.equal(currentAvailableFunding(history).toFixed(2), "20.00");

    practice = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    const supplement = await recordPracticeFunding(db, actorB, {
      practiceId: practice.id,
      reference: `PARTIAL-2-${suffix}`,
      amount: "30.00",
      currency: "EUR",
      expectedVersion: practice.version,
    });
    practice = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await confirmPracticeFunding(db, actorB, {
      practiceId: practice.id,
      evidenceId: supplement.id,
      expectedVersion: practice.version,
    });
    history = await db.practiceFundingEvidence.findMany({
      where: { practiceId: practice.id },
      include: { successor: true },
    });
    assert.equal(currentAvailableFunding(history).toFixed(2), "50.00");

    practice = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    const reversed = await reversePracticeFunding(db, actorB, {
      practiceId: practice.id,
      evidenceId: confirmations[0].id,
      expectedVersion: practice.version,
    });
    const reversedReplay = await reversePracticeFunding(db, actorB, {
      practiceId: practice.id,
      evidenceId: confirmations[0].id,
      expectedVersion: practice.version,
    });
    assert.equal(reversedReplay.id, reversed.id);
    history = await db.practiceFundingEvidence.findMany({
      where: { practiceId: practice.id },
      include: { successor: true },
      orderBy: [{ reference: "asc" }, { sequence: "asc" }],
    });
    assert.deepEqual(history.map(({ status }) => status).sort(), [
      "CONFIRMED",
      "CONFIRMED",
      "DECLARED",
      "DECLARED",
      "REVERSED",
    ]);
    assert.equal(currentAvailableFunding(history).toFixed(2), "30.00");

    practice = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await db.documentChecklistItem.update({
      where: { id: b.checklist.id },
      data: { active: false },
    });
    for (const emptyChecklistReason of [undefined, "", "   "]) {
      const beforeDeniedAttestation = await footprint(practice.id);
      await assert.rejects(
        attestPracticeMaterialsComplete(db, actorB, {
          practiceId: practice.id,
          expectedVersion: practice.version,
          emptyChecklistReason,
        }),
        (error) =>
          error instanceof PracticeReadinessError && error.code === "NOT_READY",
      );
      assert.deepEqual(
        await footprint(practice.id),
        beforeDeniedAttestation,
      );
    }
    const emptyAttestedB = await attestPracticeMaterialsComplete(db, actorB, {
      practiceId: practice.id,
      expectedVersion: practice.version,
      emptyChecklistReason: "Nessun materiale applicabile alla fase sintetica",
    });
    assert.notEqual(
      (
        await db.practiceMaterialAttestation.findUniqueOrThrow({
          where: { id: emptyAttestedB.materialsCompleteEvidenceId! },
        })
      ).snapshotHash,
      emptyAttestationAHash,
    );
    await db.documentChecklistItem.update({
      where: { id: b.checklist.id },
      data: { active: true },
    });
    practice = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await expectDeniedWithoutEffects(practice.id, () =>
      formalizePractice(db, actorB, {
        practiceId: practice.id,
        contractId: b.contract.id,
        signedDocumentId: b.document.id,
        signedDocumentVersionId: a.documentVersion.id,
        expectedVersion: practice.version,
      }),
    );
    await formalizePractice(db, actorB, {
      practiceId: practice.id,
      contractId: b.contract.id,
      signedDocumentId: b.document.id,
      signedDocumentVersionId: b.documentVersion.id,
      expectedVersion: practice.version,
    });
    practice = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await linkPracticeClientService(db, actorB, {
      practiceId: practice.id,
      clientServiceId: b.clientService.id,
      expectedVersion: practice.version,
    });
    practice = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await decidePracticeMaterial(db, actorB, {
      practiceId: practice.id,
      checklistItemId: b.checklist.id,
      status: "NOT_NEEDED",
      reason: "Fixture di accredito",
      expectedVersion: practice.version,
    });
    practice = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await attestPracticeMaterialsComplete(db, actorB, {
      practiceId: practice.id,
      expectedVersion: practice.version,
    });
    practice = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await assert.rejects(
      startPractice(db, actorB, {
        practiceId: practice.id,
        expectedVersion: practice.version,
      }),
      (error) =>
        error instanceof PracticeReadinessError && error.code === "NOT_READY",
    );

    const beforeFault = await footprint(practice.id);
    process.env.PRACTICE_READINESS_TEST_FAIL_AUDIT = "1";
    try {
      await assert.rejects(
        recordPracticeFunding(db, actorB, {
          practiceId: practice.id,
          reference: `FAULT-${suffix}`,
          amount: "1.00",
          currency: "EUR",
          expectedVersion: practice.version,
        }),
        (error) =>
          error instanceof PracticeReadinessError && error.code === "CONFLICT",
      );
    } finally {
      delete process.env.PRACTICE_READINESS_TEST_FAIL_AUDIT;
    }
    assert.deepEqual(await footprint(practice.id), beforeFault);
  },
);

test(
  "positive A path reaches every scoped transition",
  { skip: !enabled },
  async () => {
    const practice = await ensurePractice(a, actorA);
    const declared = await recordPracticeFunding(db, actorA, {
      practiceId: practice.id,
      reference: `A-${suffix}`,
      amount: "50.00",
      currency: "EUR",
      expectedVersion: practice.version,
    });
    const funded = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    const confirmed = await confirmPracticeFunding(db, actorA, {
      practiceId: practice.id,
      evidenceId: declared.id,
      expectedVersion: funded.version,
    });
    const afterFunding = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await decidePracticeMaterial(db, actorA, {
      practiceId: practice.id,
      checklistItemId: a.checklist.id,
      documentId: a.document.id,
      documentVersionId: a.documentVersion.id,
      status: "VALIDATED",
      expectedVersion: afterFunding.version,
    });
    const v2 = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    if (!v2.currentFormalizationId) {
      await formalizePractice(db, actorA, {
        practiceId: practice.id,
        contractId: a.contract.id,
        signedDocumentId: a.document.id,
        signedDocumentVersionId: a.documentVersion.id,
        expectedVersion: v2.version,
      });
    }
    const linked = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await expectDeniedWithoutEffects(practice.id, () =>
      linkPracticeClientService(db, actorA, {
        practiceId: practice.id,
        clientServiceId: b.clientService.id,
        expectedVersion: linked.version,
      }),
    );
    await linkPracticeClientService(db, actorA, {
      practiceId: practice.id,
      clientServiceId: a.clientService.id,
      expectedVersion: linked.version,
    });
    assert.equal(
      (
        await db.clientService.findUniqueOrThrow({
          where: { id: a.clientService.id },
        })
      ).status,
      "richiesto",
    );
    const v3 = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await attestPracticeMaterialsComplete(db, actorA, {
      practiceId: practice.id,
      expectedVersion: v3.version,
      emptyChecklistReason: "",
    });
    let v4 = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    const sensitiveReferenceDocument = await db.document.create({
      data: {
        clientId: a.client.id,
        projectId: a.project.id,
        type: "documento_riservato",
        title: `Riferimento sensibile ${suffix}`,
        fileName: `sensitive-reference-${suffix}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 10,
        storagePath: `synthetic/${suffix}/sensitive-reference.pdf`,
        uploadedById: ids.manager,
        status: "verificato",
        containsSensitiveData: true,
        checksum: randomBytes(32).toString("hex"),
      },
    });
    const sensitiveReferenceVersion = await db.documentVersion.create({
      data: {
        documentId: sensitiveReferenceDocument.id,
        version: 1,
        storagePath: sensitiveReferenceDocument.storagePath,
        checksum: sensitiveReferenceDocument.checksum,
      },
    });
    for (const status of ["NOT_NEEDED", "INVALIDATED"] as const)
      for (const references of [
        {
          documentId: sensitiveReferenceDocument.id,
          documentVersionId: sensitiveReferenceVersion.id,
        },
        {
          documentId: null,
          documentVersionId: sensitiveReferenceVersion.id,
        },
        {
          documentId: a.document.id,
          documentVersionId: sensitiveReferenceVersion.id,
        },
        {
          documentId: b.document.id,
          documentVersionId: b.documentVersion.id,
        },
      ])
        await expectDeniedWithoutEffects(practice.id, () =>
          decidePracticeMaterial(db, actorA, {
            practiceId: practice.id,
            checklistItemId: a.checklist.id,
            ...references,
            status,
            reason: "Riferimento facoltativo non autorizzato",
            expectedVersion: v4.version,
          }),
        );
    const invalidated = await decidePracticeMaterial(db, actorA, {
      practiceId: practice.id,
      checklistItemId: a.checklist.id,
      documentId: "",
      documentVersionId: "   ",
      status: "INVALIDATED",
      reason: "Versione sostituita nella fixture",
      expectedVersion: v4.version,
    });
    assert.equal(invalidated.documentId, null);
    assert.equal(invalidated.documentVersionId, null);
    assert.equal(invalidated.reason, "Versione sostituita nella fixture");
    v4 = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    assert.equal(v4.materialsCompleteAt, null);
    assert.equal(v4.materialsCompleteEvidenceId, null);
    for (const references of [
      { documentId: "", documentVersionId: "" },
      { documentId: b.document.id, documentVersionId: b.documentVersion.id },
    ]) {
      await expectDeniedWithoutEffects(practice.id, () =>
        decidePracticeMaterial(db, actorA, {
          practiceId: practice.id,
          checklistItemId: a.checklist.id,
          ...references,
          status: "VALIDATED",
          expectedVersion: v4.version,
        }),
      );
    }
    await decidePracticeMaterial(db, actorA, {
      practiceId: practice.id,
      checklistItemId: a.checklist.id,
      documentId: a.document.id,
      documentVersionId: a.documentVersion.id,
      status: "VALIDATED",
      expectedVersion: v4.version,
    });
    v4 = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await attestPracticeMaterialsComplete(db, actorA, {
      practiceId: practice.id,
      expectedVersion: v4.version,
      emptyChecklistReason: "",
    });
    v4 = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await db.documentChecklistItem.update({
      where: { id: a.checklist.id },
      data: { title: "Materiale A aggiornato dopo attestazione" },
    });
    await assert.rejects(
      startPractice(db, actorA, {
        practiceId: practice.id,
        expectedVersion: v4.version,
      }),
      (error) =>
        error instanceof PracticeReadinessError && error.code === "NOT_READY",
    );
    await attestPracticeMaterialsComplete(db, actorA, {
      practiceId: practice.id,
      expectedVersion: v4.version,
      emptyChecklistReason: "   ",
    });
    v4 = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    await db.documentChecklistItem.update({
      where: { id: a.checklist.id },
      data: { active: false },
    });
    const emptyReasonA = "Nessun materiale applicabile alla fase sintetica";
    const selectedA = await attestPracticeMaterialsComplete(db, actorA, {
      practiceId: practice.id,
      expectedVersion: v4.version,
      emptyChecklistReason: emptyReasonA,
    });
    const selectedB = await attestPracticeMaterialsComplete(db, actorA, {
      practiceId: practice.id,
      expectedVersion: selectedA.version,
      emptyChecklistReason: "Motivazione alternativa verificabile",
    });
    const selectedAgainA = await attestPracticeMaterialsComplete(db, actorA, {
      practiceId: practice.id,
      expectedVersion: selectedB.version,
      emptyChecklistReason: emptyReasonA,
    });
    assert.equal(
      selectedAgainA.materialsCompleteEvidenceId,
      selectedA.materialsCompleteEvidenceId,
    );
    const attestationsAfterSelection =
      await db.practiceMaterialAttestation.count({
        where: { practiceId: practice.id },
      });
    const auditsAfterSelection = await db.auditLog.count({
      where: {
        entityType: "PracticeReadiness",
        entityId: practice.id,
        event: "practice_materials_complete",
      },
    });
    const replayedA = await attestPracticeMaterialsComplete(db, actorA, {
      practiceId: practice.id,
      expectedVersion: selectedAgainA.version,
      emptyChecklistReason: emptyReasonA,
    });
    assert.equal(replayedA.version, selectedAgainA.version);
    assert.equal(
      replayedA.materialsCompleteEvidenceId,
      selectedA.materialsCompleteEvidenceId,
    );
    assert.equal(
      await db.practiceMaterialAttestation.count({
        where: { practiceId: practice.id },
      }),
      attestationsAfterSelection,
    );
    assert.equal(
      await db.auditLog.count({
        where: {
          entityType: "PracticeReadiness",
          entityId: practice.id,
          event: "practice_materials_complete",
        },
      }),
      auditsAfterSelection,
    );
    v4 = replayedA;
    const beforeStart = await footprint(practice.id);
    process.env.PRACTICE_READINESS_TEST_FAIL_AUDIT = "1";
    try {
      await assert.rejects(
        startPractice(db, actorA, {
          practiceId: practice.id,
          expectedVersion: v4.version,
        }),
        (error) =>
          error instanceof PracticeReadinessError && error.code === "CONFLICT",
      );
    } finally {
      delete process.env.PRACTICE_READINESS_TEST_FAIL_AUDIT;
    }
    assert.deepEqual(await footprint(practice.id), beforeStart);
    assert.equal(
      (
        await db.clientService.findUniqueOrThrow({
          where: { id: a.clientService.id },
        })
      ).status,
      "richiesto",
    );
    const started = await startPractice(db, actorA, {
      practiceId: practice.id,
      expectedVersion: v4.version,
    });
    assert.ok(started.startedAt);
    const startEvidence = started.startEvidence as {
      formalizationId?: string;
      clientServiceId?: string;
      materialSnapshotHash?: string;
    };
    assert.equal(startEvidence.formalizationId, started.currentFormalizationId);
    assert.equal(startEvidence.clientServiceId, a.clientService.id);
    assert.equal(
      startEvidence.materialSnapshotHash,
      (
        await db.practiceMaterialAttestation.findUniqueOrThrow({
          where: { id: selectedA.materialsCompleteEvidenceId! },
        })
      ).snapshotHash,
    );
    assert.equal(
      (
        await db.clientService.findUniqueOrThrow({
          where: { id: a.clientService.id },
        })
      ).status,
      "in_lavorazione",
    );
    assert.equal(started.startedById, ids.userA);
    const historicalEvidence = started.startEvidence;
    const reversal = await reversePracticeFunding(db, actorA, {
      practiceId: practice.id,
      evidenceId: confirmed.id,
      expectedVersion: started.version,
    });
    assert.equal(reversal.status, "REVERSED");
    const afterReversal = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
    });
    assert.deepEqual(afterReversal.startEvidence, historicalEvidence);
    assert.equal(
      afterReversal.startedAt?.toISOString(),
      started.startedAt?.toISOString(),
    );
    const afterHistory = await db.practiceFundingEvidence.findMany({
      where: { practiceId: practice.id },
      include: { successor: true },
    });
    assert.equal(currentAvailableFunding(afterHistory).toFixed(2), "0.00");
    assert.ok((await footprint(practice.id)).audits >= 9);
    assert.equal(
      (await listAccessiblePracticeReadiness(db, manager)).some(
        ({ id }) => id === practice.id,
      ),
      true,
    );
    const preAnalysis = await db.preAnalysis.create({ data: { clientId: a.client.id, projectId: a.project.id, internalSummary: "Preanalisi sintetica dossier" } });
    const dossierCountBeforeFault = await db.clientDossier.count({ where: { practiceReadinessId: practice.id } });
    await assert.rejects(
      createEngagementDossier(db, actorA, { practiceReadinessId: practice.id, preAnalysisId: preAnalysis.id, title: "Dossier sintetico v1", content: "Contenuto sintetico iniziale" }, { failAudit: true }),
      (error) => error instanceof EngagementDossierError && error.code === "CONFLICT",
    );
    assert.equal(await db.clientDossier.count({ where: { practiceReadinessId: practice.id } }), dossierCountBeforeFault);
    const createdDossier = await createEngagementDossier(db, actorA, { practiceReadinessId: practice.id, preAnalysisId: preAnalysis.id, title: "Dossier sintetico v1", content: "Contenuto sintetico iniziale" });
    const dossierFootprintBeforeRevocation = {
      versions: await db.engagementDossierVersion.count({ where: { dossierId: createdDossier.dossier.id } }),
      audits: await db.auditLog.count({ where: { entityType: "ClientDossier", entityId: createdDossier.dossier.id } }),
    };
    await db.internalSession.update({ where: { id: ids.sessionA }, data: { revokedAt: new Date(), revokedReason: "INTERNAL_SINGLE", revokedByUserId: ids.manager } });
    try {
      await assert.rejects(
        reviseEngagementDossier(db, actorA, { dossierId: createdDossier.dossier.id, expectedVersionId: createdDossier.version.id, title: "Versione vietata", content: "Sessione revocata" }),
        (error) => error instanceof EngagementDossierError && error.code === "DENIED",
      );
      assert.deepEqual({
        versions: await db.engagementDossierVersion.count({ where: { dossierId: createdDossier.dossier.id } }),
        audits: await db.auditLog.count({ where: { entityType: "ClientDossier", entityId: createdDossier.dossier.id } }),
      }, dossierFootprintBeforeRevocation);
    } finally {
      await db.internalSession.update({ where: { id: ids.sessionA }, data: { revokedAt: null, revokedReason: null, revokedByUserId: null } });
    }
    await reviewEngagementDossierVersion(db, manager, { dossierId: createdDossier.dossier.id, versionId: createdDossier.version.id, versionHash: createdDossier.version.contentHash, decision: "REQUEST_CHANGES", note: "Integrare il contenuto sintetico" });
    await assert.rejects(
      reviewEngagementDossierVersion(db, manager, { dossierId: createdDossier.dossier.id, versionId: createdDossier.version.id, versionHash: createdDossier.version.contentHash, decision: "APPROVED", note: "Non approvabile senza nuova versione" }),
      (error) => error instanceof EngagementDossierError && error.code === "CONFLICT",
    );
    const version2 = await reviseEngagementDossier(db, actorA, { dossierId: createdDossier.dossier.id, expectedVersionId: createdDossier.version.id, title: "Dossier sintetico v2", content: "Contenuto sintetico corretto" });
    await reviewEngagementDossierVersion(db, manager, { dossierId: createdDossier.dossier.id, versionId: version2.id, versionHash: version2.contentHash, decision: "APPROVED", note: "Versione verificata" });
    const exported = await exportApprovedEngagementDossier(db, actorA, { dossierId: createdDossier.dossier.id, versionId: version2.id, format: "markdown" }, version2.content);
    assert.equal(exported.version.contentHash, version2.contentHash);
    await assert.rejects(authorizeEngagementDossierDelivery(db, actorA, { dossierId: createdDossier.dossier.id, versionId: version2.id, versionHash: version2.contentHash, recipients: [{ kind: "CLIENT", name: "Destinatario non autorizzato", address: "synthetic.invalid", synthetic: true }] }), (error) => error instanceof EngagementDossierError && error.code === "DENIED");
    const authorization = await authorizeEngagementDossierDelivery(db, manager, { dossierId: createdDossier.dossier.id, versionId: version2.id, versionHash: version2.contentHash, recipients: [{ kind: "CLIENT", name: "Cliente sintetico", address: "cliente@invalid.test", synthetic: true }] });
    const receiptInput = { authorizationId: authorization.id, outcome: "DELIVERED" as const, evidence: { reference: "RICEVUTA-SINTETICA-001", deliveredAt: new Date(), synthetic: true, note: "Consegna manuale sintetica" } };
    const receipt = await recordEngagementDossierDelivery(db, actorA, receiptInput);
    assert.equal((await recordEngagementDossierDelivery(db, actorA, receiptInput)).id, receipt.id);
    const concurrentRevisions = await Promise.allSettled([
      reviseEngagementDossier(db, actorA, { dossierId: createdDossier.dossier.id, expectedVersionId: version2.id, title: "Dossier sintetico v3 A", content: "Prima revisione concorrente" }),
      reviseEngagementDossier(db, actorA, { dossierId: createdDossier.dossier.id, expectedVersionId: version2.id, title: "Dossier sintetico v3 B", content: "Seconda revisione concorrente" }),
    ]);
    assert.equal(concurrentRevisions.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(concurrentRevisions.filter(({ status }) => status === "rejected").length, 1);
    const version3 = concurrentRevisions.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof reviseEngagementDossier>> > => result.status === "fulfilled")!.value;
    const afterRevision = await db.clientDossier.findUniqueOrThrow({ where: { id: createdDossier.dossier.id } });
    assert.equal(afterRevision.approvedVersionId, null);
    await assert.rejects(exportApprovedEngagementDossier(db, actorA, { dossierId: createdDossier.dossier.id, versionId: version3.id, format: "markdown" }, version3.content), (error) => error instanceof EngagementDossierError && error.code === "NOT_READY");
    const updatedOffer = await db.commercialOffer.update({
      where: { id: a.offer.id },
      data: { description: "Proposta successiva ad avvio da negare" },
    });
    const postStartRevision = await proposePracticeOfferRevision(db, actorA, {
      controlledIntakeId: a.intake.id,
      commercialOfferId: a.offer.id,
      serviceRevisionId: revisionId,
      clientId: a.client.id,
      projectId: a.project.id,
      digitalProjectType: "software_crm_workflow",
      scope: "Perimetro successivo ad avvio",
      startupConditions: "Non deve sostituire la pratica avviata",
      requiredInitialAmount: "50.00",
      expectedOfferUpdatedAt: updatedOffer.updatedAt,
    });
    const beforePostStartAcceptance = await footprint(practice.id);
    const postStartAttempts = await Promise.allSettled([
      createPracticeReadiness(db, actorA, {
        offerRevisionId: postStartRevision.id,
      }),
      createPracticeReadiness(db, actorA, {
        offerRevisionId: postStartRevision.id,
      }),
    ]);
    assert.equal(
      postStartAttempts.every(
        (result) => result.status === "rejected" && denied(result.reason),
      ),
      true,
    );
    assert.deepEqual(await footprint(practice.id), beforePostStartAcceptance);
    assert.equal(
      await db.practiceOfferAcceptance.count({
        where: { offerRevisionId: postStartRevision.id },
      }),
      0,
    );
  },
);
