import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AuthSession } from "./auth";
import { canonicalSha256 } from "./canonical-json";
import { canEditClient, canViewClient } from "./access-control";
import { hasPermission } from "./permission-evaluator";
import { lockAuthoritativeInternalSession } from "./internal-session-registry";
import {
  assertSyntheticCatalogDatabase,
  catalogRevisionIsSelectable,
} from "./service-catalog-v2-persistence";
import {
  FAI_SERVICE_CATALOG_V2,
  validateCatalogSelection,
} from "./service-catalog-v2";

export class PracticeReadinessError extends Error {
  constructor(readonly code: "DISABLED" | "DENIED" | "CONFLICT" | "NOT_READY") {
    super(code);
  }
}
export const exactMoneySchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/, "Importo monetario non valido.")
  .refine((v) => new Prisma.Decimal(v).gt(0), "Importo monetario non valido.");
const nonnegativeMoneySchema = z
  .string()
  .trim()
  .regex(
    /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/,
    "Importo monetario non valido.",
  );
const proposalSchema = z.object({
  controlledIntakeId: z.string().uuid(),
  commercialOfferId: z.string().min(1),
  serviceRevisionId: z.string().uuid(),
  clientId: z.string().min(1),
  projectId: z.string().optional().nullable(),
  digitalProjectType: z.string().optional().nullable(),
  scope: z.string().trim().min(1).max(4000),
  startupConditions: z.string().trim().min(1).max(4000),
  requiredInitialAmount: nonnegativeMoneySchema,
  expectedOfferUpdatedAt: z.coerce.date(),
});
const acceptanceSchema = z.object({ offerRevisionId: z.string().uuid() });
const fundingSchema = z.object({
  practiceId: z.string().uuid(),
  reference: z.string().trim().min(1).max(120),
  amount: exactMoneySchema,
  currency: z.literal("EUR"),
  expectedVersion: z.coerce.number().int().positive(),
});
const fundingTransitionSchema = z.object({
  practiceId: z.string().uuid(),
  evidenceId: z.string().uuid(),
  expectedVersion: z.coerce.number().int().positive(),
});
const optionalMaterialReferenceSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? null : value,
  z.string().trim().min(1).max(191).optional().nullable(),
);
const materialSchema = z
  .object({
    practiceId: z.string().uuid(),
    checklistItemId: z.string().min(1),
    documentId: optionalMaterialReferenceSchema,
    documentVersionId: optionalMaterialReferenceSchema,
    status: z.enum(["VALIDATED", "NOT_NEEDED", "INVALIDATED"]),
    reason: z.string().trim().max(500).optional().nullable(),
    expectedVersion: z.coerce.number().int().positive(),
  })
  .superRefine((v, c) => {
    if (v.status === "NOT_NEEDED" && !v.reason)
      c.addIssue({ code: "custom", message: "Motivazione obbligatoria." });
  });
export function parsePracticeMaterialInput(raw: unknown) {
  const parsed = materialSchema.safeParse(raw);
  if (!parsed.success) throw new PracticeReadinessError("DENIED");
  return parsed.data;
}
const startSchema = z.object({
  practiceId: z.string().uuid(),
  expectedVersion: z.coerce.number().int().positive(),
});
const linkServiceSchema = z.object({
  practiceId: z.string().uuid(),
  clientServiceId: z.string().min(1).max(191),
  expectedVersion: z.coerce.number().int().positive(),
});
type Db = Pick<PrismaClient, "$transaction" | "$queryRaw">;
function enabled() {
  if (process.env.PRACTICE_READINESS_MODE !== "synthetic")
    throw new PracticeReadinessError("DISABLED");
}
async function actor(
  tx: Prisma.TransactionClient,
  claimed: AuthSession,
  permission: "service.read" | "service.write" = "service.write",
) {
  const s = claimed.sessionId
    ? await lockAuthoritativeInternalSession(tx, {
        sessionId: claimed.sessionId,
        userId: claimed.userId,
      })
    : null;
  if (
    !s ||
    s.revokedAt ||
    !s.live ||
    !s.active ||
    s.deletedAt ||
    !hasPermission(
      {
        role: s.role,
        active: s.active,
        permissionOverrides: s.permissionOverrides,
      },
      permission,
    )
  )
    throw new PracticeReadinessError("DENIED");
  return s;
}
async function practiceScope(
  tx: Prisma.TransactionClient,
  a: Awaited<ReturnType<typeof actor>>,
  id: string,
  write = true,
) {
  const practice = await tx.practiceReadiness.findUnique({ where: { id } });
  if (!practice) throw new PracticeReadinessError("DENIED");
  const [client, project, intake] = await Promise.all([
    tx.client.findUnique({ where: { id: practice.clientId } }),
    practice.projectId
      ? tx.project.findUnique({ where: { id: practice.projectId } })
      : null,
    tx.controlledIntake.findUnique({
      where: { id: practice.controlledIntakeId },
    }),
  ]);
  const lead = intake
    ? await tx.lead.findUnique({ where: { id: intake.leadId } })
    : null;
  if (
    !client ||
    client.deletedAt ||
    (practice.projectId &&
      (!project || project.deletedAt || project.clientId !== client.id)) ||
    !intake ||
    !lead ||
    lead.deletedAt ||
    lead.clientId !== client.id ||
    (write ? !canEditClient(a, client) : !canViewClient(a, client))
  )
    throw new PracticeReadinessError("DENIED");
  return { practice, client, project, intake, lead };
}

export function practiceOfferSnapshotHash(input: {
  offerId: string;
  updatedAt: Date;
  taxableAmount: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  revisionId: string;
}) {
  return canonicalSha256({
    offerId: input.offerId,
    updatedAt: input.updatedAt.toISOString(),
    amounts: [
      input.taxableAmount.toFixed(2),
      input.vatAmount.toFixed(2),
      input.totalAmount.toFixed(2),
    ],
    revisionId: input.revisionId,
  });
}

export async function proposePracticeOfferRevision(
  db: Db,
  claimed: AuthSession,
  raw: unknown,
) {
  enabled();
  const input = proposalSchema.parse(raw);
  await assertSyntheticCatalogDatabase(db);
  return db.$transaction(
    async (tx) => {
      const a = await actor(tx, claimed);
      const [intake, offer, catalogRevision, client, project] =
        await Promise.all([
          tx.controlledIntake.findUnique({
            where: { id: input.controlledIntakeId },
          }),
          tx.commercialOffer.findUnique({
            where: { id: input.commercialOfferId },
          }),
          tx.serviceCatalogRevision.findUnique({
            where: { id: input.serviceRevisionId },
            include: { serviceCatalog: true },
          }),
          tx.client.findUnique({ where: { id: input.clientId } }),
          input.projectId
            ? tx.project.findUnique({ where: { id: input.projectId } })
            : null,
        ]);
      const lead = intake
        ? await tx.lead.findUnique({ where: { id: intake.leadId } })
        : null;
      const definition = FAI_SERVICE_CATALOG_V2.find(
        (item) => item.code === catalogRevision?.serviceCatalog.code,
      );
      if (
        !intake ||
        !lead ||
        lead.deletedAt ||
        lead.clientId !== client?.id ||
        !client ||
        client.deletedAt ||
        !canEditClient(a, client) ||
        !offer ||
        offer.deletedAt ||
        offer.clientId !== client.id ||
        offer.leadId !== lead.id ||
        offer.updatedAt.getTime() !== input.expectedOfferUpdatedAt.getTime() ||
        !offer.validUntil ||
        offer.validUntil <= new Date() ||
        !catalogRevision ||
        !definition ||
        !catalogRevisionIsSelectable(definition, catalogRevision, new Date()) ||
        (input.projectId &&
          (!project || project.deletedAt || project.clientId !== client.id))
      )
        throw new PracticeReadinessError("DENIED");
      validateCatalogSelection(
        definition.code,
        input.digitalProjectType ?? undefined,
      );
      const taxable = offer.taxableAmount,
        vat = offer.vatAmount,
        total = offer.totalAmount,
        initial = new Prisma.Decimal(input.requiredInitialAmount);
      if (
        !taxable.add(vat).equals(total) ||
        initial.gt(total) ||
        (definition.priceMode === "FIXED" &&
          (!catalogRevision.netPrice ||
            !catalogRevision.netPrice.equals(taxable))) ||
        (definition.priceMode === "QUOTE_ONLY" &&
          catalogRevision.netPrice !== null)
      )
        throw new PracticeReadinessError("DENIED");
      const latest = await tx.practiceOfferRevision.findFirst({
        where: { commercialOfferId: offer.id },
        orderBy: { revision: "desc" },
      });
      const revision = (latest?.revision ?? 0) + 1;
      const snapshot = {
        controlledIntakeId: intake.id,
        commercialOfferId: offer.id,
        revision,
        serviceRevisionId: catalogRevision.id,
        clientId: client.id,
        projectId: project?.id ?? null,
        digitalProjectType: input.digitalProjectType ?? null,
        scope: input.scope,
        inclusions: definition.detail.inclusions,
        exclusions: definition.detail.exclusions,
        deliverables: definition.detail.deliverables,
        taxableAmount: taxable.toFixed(2),
        vatAmount: vat.toFixed(2),
        totalAmount: total.toFixed(2),
        requiredInitialAmount: initial.toFixed(2),
        currency: "EUR",
        validUntil: offer.validUntil.toISOString(),
        startupConditions: input.startupConditions,
      };
      const payloadHash = canonicalSha256(snapshot);
      const row = await tx.practiceOfferRevision.create({
        data: {
          ...snapshot,
          taxableAmount: taxable,
          vatAmount: vat,
          totalAmount: total,
          requiredInitialAmount: initial,
          validUntil: offer.validUntil,
          proposedById: a.userId,
          payloadHash,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: a.userId,
          event: "practice_offer_revision_proposed",
          entityType: "PracticeOfferRevision",
          entityId: row.id,
          after: { revision, payloadHash },
        },
      });
      maybeFailAudit();
      return row;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function createPracticeReadiness(
  db: Db,
  claimed: AuthSession,
  raw: unknown,
) {
  enabled();
  const input = acceptanceSchema.parse(raw);
  await assertSyntheticCatalogDatabase(db);
  return db.$transaction(
    async (tx) => {
      const a = await actor(tx, claimed);
      const revision = await tx.practiceOfferRevision.findUnique({
        where: { id: input.offerRevisionId },
      });
      if (!revision || revision.validUntil <= new Date())
        throw new PracticeReadinessError("DENIED");
      const same = await tx.practiceReadiness.findFirst({
        where: { acceptedOfferRevisionId: revision.id },
      });
      if (same) {
        await practiceScope(tx, a, same.id);
        return same;
      }
      const [client, intake, project, catalogRevision] = await Promise.all([
        tx.client.findUnique({ where: { id: revision.clientId } }),
        tx.controlledIntake.findUnique({
          where: { id: revision.controlledIntakeId },
        }),
        revision.projectId
          ? tx.project.findUnique({ where: { id: revision.projectId } })
          : null,
        tx.serviceCatalogRevision.findUnique({
          where: { id: revision.serviceRevisionId },
          include: { serviceCatalog: true },
        }),
      ]);
      const lead = intake
        ? await tx.lead.findUnique({ where: { id: intake.leadId } })
        : null;
      const definition = FAI_SERVICE_CATALOG_V2.find(
        (item) => item.code === catalogRevision?.serviceCatalog.code,
      );
      if (
        !client ||
        client.deletedAt ||
        !canEditClient(a, client) ||
        !lead ||
        lead.deletedAt ||
        lead.clientId !== client.id ||
        (revision.projectId &&
          (!project || project.deletedAt || project.clientId !== client.id)) ||
        !catalogRevision ||
        !definition ||
        !catalogRevisionIsSelectable(definition, catalogRevision, new Date())
      )
        throw new PracticeReadinessError("DENIED");
      const acceptedAt = new Date();
      const evidenceHash = canonicalSha256({
        offerRevisionId: revision.id,
        payloadHash: revision.payloadHash,
        acceptedAt: acceptedAt.toISOString(),
        acceptedById: a.userId,
      });
      await tx.practiceOfferAcceptance.create({
        data: {
          offerRevisionId: revision.id,
          acceptedAt,
          acceptedById: a.userId,
          evidenceHash,
        },
      });
      const current = await tx.practiceReadiness.findUnique({
        where: { controlledIntakeId: revision.controlledIntakeId },
      });
      const data = {
        commercialOfferId: revision.commercialOfferId,
        offerSnapshotHash: revision.payloadHash,
        offerRevision: revision.revision,
        acceptedOfferRevisionId: revision.id,
        serviceRevisionId: revision.serviceRevisionId,
        clientId: revision.clientId,
        projectId: revision.projectId,
        requiredInitialAmount: revision.requiredInitialAmount,
        contractId: null,
        clientServiceId: null,
        currentFormalizationId: null,
        signedDocumentId: null,
        signedDocumentVersionId: null,
        formalizedAt: null,
        formalizedById: null,
        materialsCompleteAt: null,
        materialsCompleteById: null,
        materialsCompleteEvidenceId: null,
      };
      const row = current
        ? await tx.practiceReadiness.update({
            where: { id: current.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.practiceReadiness.create({
            data: {
              controlledIntakeId: revision.controlledIntakeId,
              ...data,
              updatedAt: new Date(),
            },
          });
      await tx.auditLog.create({
        data: {
          actorId: a.userId,
          event: "practice_offer_revision_accepted",
          entityType: "PracticeReadiness",
          entityId: row.id,
          after: { offerRevisionId: revision.id, evidenceHash },
        },
      });
      maybeFailAudit();
      return row;
    },
    { isolationLevel: "Serializable" },
  );
}
export async function recordPracticeFunding(
  db: Db,
  claimed: AuthSession,
  raw: unknown,
) {
  enabled();
  const input = fundingSchema.parse(raw);
  await assertSyntheticCatalogDatabase(db);
  const payloadHash = canonicalSha256({
    operation: "DECLARE",
    reference: input.reference,
    amount: input.amount,
    currency: input.currency,
  });
  return fundingTransaction(db, async (tx) => {
    const a = await actor(tx, claimed);
    const { practice } = await practiceScope(tx, a, input.practiceId);
    const old = await tx.practiceFundingEvidence.findFirst({
      where: {
        practiceId: practice.id,
        reference: input.reference,
        sequence: 1,
      },
    });
    if (old) {
      if (old.payloadHash !== payloadHash)
        throw new PracticeReadinessError("CONFLICT");
      return old;
    }
    if (practice.version !== input.expectedVersion)
      throw new PracticeReadinessError("CONFLICT");
    const row = await tx.practiceFundingEvidence.create({
      data: {
        practiceId: practice.id,
        reference: input.reference,
        amount: new Prisma.Decimal(input.amount),
        currency: input.currency,
        status: "DECLARED",
        sequence: 1,
        payloadHash,
      },
    });
    await tx.practiceReadiness.update({
      where: { id: practice.id, version: input.expectedVersion },
      data: { version: { increment: 1 } },
    });
    await writeFundingAudit(tx, a.userId, practice.id, row);
    return row;
  });
}

async function transitionPracticeFunding(
  db: Db,
  claimed: AuthSession,
  raw: unknown,
  status: "CONFIRMED" | "REVERSED",
) {
  enabled();
  const input = fundingTransitionSchema.parse(raw);
  await assertSyntheticCatalogDatabase(db);
  return fundingTransaction(db, async (tx) => {
    const a = await actor(tx, claimed);
    const { practice } = await practiceScope(tx, a, input.practiceId);
    const source = await tx.practiceFundingEvidence.findUnique({
      where: { id: input.evidenceId },
      include: { successor: true },
    });
    if (!source || source.practiceId !== practice.id)
      throw new PracticeReadinessError("DENIED");
    const payloadHash = canonicalSha256({
      operation: status,
      sourceId: source.id,
      reference: source.reference,
      amount: String(source.amount),
      currency: source.currency,
    });
    if (source.successor) {
      if (
        source.successor.status !== status ||
        source.successor.payloadHash !== payloadHash
      )
        throw new PracticeReadinessError("CONFLICT");
      return source.successor;
    }
    if (practice.version !== input.expectedVersion)
      throw new PracticeReadinessError("CONFLICT");
    if (
      (status === "CONFIRMED" && source.status !== "DECLARED") ||
      (status === "REVERSED" && source.status !== "CONFIRMED")
    )
      throw new PracticeReadinessError("CONFLICT");
    const row = await tx.practiceFundingEvidence.create({
      data: {
        practiceId: practice.id,
        reference: source.reference,
        amount: source.amount,
        currency: source.currency,
        status,
        sequence: source.sequence + 1,
        predecessorId: source.id,
        payloadHash,
        verifiedAt: new Date(),
        verifiedById: a.userId,
      },
    });
    await tx.practiceReadiness.update({
      where: { id: practice.id, version: input.expectedVersion },
      data: { version: { increment: 1 } },
    });
    await writeFundingAudit(tx, a.userId, practice.id, row);
    return row;
  });
}

async function fundingTransaction<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(fn, { isolationLevel: "Serializable" });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        !["P2002", "P2034"].includes(error.code) ||
        attempt === 2
      )
        throw error;
    }
  }
  throw new PracticeReadinessError("CONFLICT");
}

async function writeFundingAudit(
  tx: Prisma.TransactionClient,
  actorId: string,
  practiceId: string,
  row: {
    id: string;
    reference: string;
    status: string;
    amount: Prisma.Decimal;
  },
) {
  await tx.auditLog.create({
    data: {
      actorId,
      event: `practice_funding_${row.status.toLowerCase()}`,
      entityType: "PracticeReadiness",
      entityId: practiceId,
      after: {
        fundingEvidenceId: row.id,
        reference: row.reference,
        status: row.status,
        amount: String(row.amount),
      },
    },
  });
  maybeFailAudit();
}

function maybeFailAudit() {
  if (process.env.PRACTICE_READINESS_TEST_FAIL_AUDIT === "1")
    throw new PracticeReadinessError("CONFLICT");
}

export function currentAvailableFunding(
  rows: Array<{
    id: string;
    status: string;
    amount: Prisma.Decimal;
    successor?: unknown;
  }>,
) {
  return rows
    .filter((row) => row.status === "CONFIRMED" && !row.successor)
    .reduce((sum, row) => sum.add(row.amount), new Prisma.Decimal(0));
}
export function confirmPracticeFunding(
  db: Db,
  claimed: AuthSession,
  raw: unknown,
) {
  return transitionPracticeFunding(db, claimed, raw, "CONFIRMED");
}
export function reversePracticeFunding(
  db: Db,
  claimed: AuthSession,
  raw: unknown,
) {
  return transitionPracticeFunding(db, claimed, raw, "REVERSED");
}
export async function decidePracticeMaterial(
  db: Db,
  claimed: AuthSession,
  raw: unknown,
) {
  enabled();
  const input = parsePracticeMaterialInput(raw);
  await assertSyntheticCatalogDatabase(db);
  return db.$transaction(
    async (tx) => {
      const a = await actor(tx, claimed);
      const { practice } = await practiceScope(tx, a, input.practiceId);
      if (practice.version !== input.expectedVersion)
        throw new PracticeReadinessError("CONFLICT");
      const item = await tx.documentChecklistItem.findUnique({
        where: { id: input.checklistItemId },
      });
      if (
        !item ||
        item.clientId !== practice.clientId ||
        item.projectId !== practice.projectId ||
        item.deletedAt ||
        !item.active
      )
        throw new PracticeReadinessError("DENIED");
      let documentChecksum: string | null = null;
      if (input.status === "VALIDATED") {
        if (
          !input.documentId ||
          !input.documentVersionId ||
          item.documentId !== input.documentId
        )
          throw new PracticeReadinessError("DENIED");
        const [document, version, latest] = await Promise.all([
          tx.document.findUnique({ where: { id: input.documentId } }),
          tx.documentVersion.findUnique({
            where: { id: input.documentVersionId },
          }),
          tx.documentVersion.findFirst({
            where: { documentId: input.documentId },
            orderBy: { version: "desc" },
          }),
        ]);
        if (
          !document ||
          document.deletedAt ||
          (document.validUntil && document.validUntil <= new Date()) ||
          document.clientId !== practice.clientId ||
          document.projectId !== practice.projectId ||
          document.status !== "verificato" ||
          !version ||
          version.documentId !== document.id ||
          latest?.id !== version.id
        )
          throw new PracticeReadinessError("DENIED");
        documentChecksum = version.checksum ?? document.checksum;
      }
      const previous = await tx.practiceMaterialEvidence.findFirst({
        where: { practiceId: practice.id, checklistItemId: item.id },
        orderBy: { sequence: "desc" },
      });
      const sequence = (previous?.sequence ?? 0) + 1;
      const payloadHash = canonicalSha256({
        practiceId: practice.id,
        checklistItemId: item.id,
        documentId: input.documentId ?? null,
        documentVersionId: input.documentVersionId ?? null,
        documentChecksum,
        status: input.status,
        reason: input.reason ?? null,
        sequence,
      });
      const row = await tx.practiceMaterialEvidence.create({
        data: {
          practiceId: practice.id,
          checklistItemId: item.id,
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          documentChecksum,
          status: input.status,
          reason: input.reason,
          payloadHash,
          sequence,
          predecessorId: previous?.id,
          decidedAt: new Date(),
          decidedById: a.userId,
        },
      });
      await tx.practiceReadiness.update({
        where: { id: practice.id, version: input.expectedVersion },
        data: {
          version: { increment: 1 },
          materialsCompleteAt: null,
          materialsCompleteById: null,
          materialsCompleteEvidenceId: null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: a.userId,
          event: "practice_material_decided",
          entityType: "PracticeReadiness",
          entityId: practice.id,
          after: {
            materialEvidenceId: row.id,
            checklistItemId: item.id,
            status: row.status,
          },
        },
      });
      maybeFailAudit();
      return row;
    },
    { isolationLevel: "Serializable" },
  );
}

async function resolvePrerequisites(
  tx: Prisma.TransactionClient,
  practiceId: string,
) {
  const practice = await tx.practiceReadiness.findUnique({
    where: { id: practiceId },
    include: {
      funding: { include: { successor: true } },
      materials: { include: { successor: true } },
      materialAttestations: true,
    },
  });
  if (!practice) throw new PracticeReadinessError("DENIED");
  const [
    revision,
    acceptance,
    formalization,
    contract,
    document,
    documentVersion,
    clientService,
    serviceRevision,
    items,
  ] = await Promise.all([
    tx.practiceOfferRevision.findUnique({
      where: { id: practice.acceptedOfferRevisionId },
    }),
    tx.practiceOfferAcceptance.findUnique({
      where: { offerRevisionId: practice.acceptedOfferRevisionId },
    }),
    practice.currentFormalizationId
      ? tx.practiceFormalization.findUnique({
          where: { id: practice.currentFormalizationId },
        })
      : null,
    practice.contractId
      ? tx.contract.findUnique({ where: { id: practice.contractId } })
      : null,
    practice.signedDocumentId
      ? tx.document.findUnique({ where: { id: practice.signedDocumentId } })
      : null,
    practice.signedDocumentVersionId
      ? tx.documentVersion.findUnique({
          where: { id: practice.signedDocumentVersionId },
        })
      : null,
    practice.clientServiceId
      ? tx.clientService.findUnique({ where: { id: practice.clientServiceId } })
      : null,
    tx.serviceCatalogRevision.findUnique({
      where: { id: practice.serviceRevisionId },
    }),
    tx.documentChecklistItem.findMany({
      where: {
        clientId: practice.clientId,
        projectId: practice.projectId,
        active: true,
        deletedAt: null,
      },
      orderBy: { id: "asc" },
    }),
  ]);
  const terminal = practice.materials.filter((row) => !row.successor);
  const materialRows = [] as Array<{
    itemId: string;
    itemUpdatedAt: string;
    evidenceId: string;
    documentVersionId: string | null;
  }>;
  const missing: string[] = [];
  for (const item of items) {
    const evidence = terminal.find((row) => row.checklistItemId === item.id);
    if (!evidence) {
      missing.push(`materiale:${item.id}`);
      continue;
    }
    if (evidence.status === "NOT_NEEDED") {
      if (!evidence.reason) missing.push(`motivazione:${item.id}`);
      else
        materialRows.push({
          itemId: item.id,
          itemUpdatedAt: item.updatedAt.toISOString(),
          evidenceId: evidence.id,
          documentVersionId: null,
        });
      continue;
    }
    if (
      evidence.status !== "VALIDATED" ||
      !evidence.documentId ||
      !evidence.documentVersionId
    ) {
      missing.push(`materiale:${item.id}`);
      continue;
    }
    const [doc, version, latest] = await Promise.all([
      tx.document.findUnique({ where: { id: evidence.documentId } }),
      tx.documentVersion.findUnique({
        where: { id: evidence.documentVersionId },
      }),
      tx.documentVersion.findFirst({
        where: { documentId: evidence.documentId },
        orderBy: { version: "desc" },
      }),
    ]);
    if (
      !doc ||
      doc.deletedAt ||
      (doc.validUntil && doc.validUntil <= new Date()) ||
      doc.status !== "verificato" ||
      item.documentId !== doc.id ||
      !version ||
      version.documentId !== doc.id ||
      latest?.id !== version.id ||
      (version.checksum ?? doc.checksum) !== evidence.documentChecksum
    )
      missing.push(`materiale:${item.id}`);
    else
      materialRows.push({
        itemId: item.id,
        itemUpdatedAt: item.updatedAt.toISOString(),
        evidenceId: evidence.id,
        documentVersionId: version.id,
      });
  }
  const materialSnapshot = {
    items: materialRows,
    emptyChecklistReason: items.length
      ? null
      : ((
          practice.materialAttestations.at(-1)?.snapshot as
            | { emptyChecklistReason?: string }
            | undefined
        )?.emptyChecklistReason ?? null),
  };
  const materialHash = canonicalSha256(materialSnapshot);
  const complete = practice.materialsCompleteEvidenceId
    ? practice.materialAttestations.find(
        (row) => row.id === practice.materialsCompleteEvidenceId,
      )
    : null;
  if (!complete || complete.snapshotHash !== materialHash)
    missing.push("completezza_materiali");
  const paid = currentAvailableFunding(practice.funding);
  if (paid.lt(practice.requiredInitialAmount))
    missing.push("accredito_iniziale");
  if (!revision || !acceptance) missing.push("preventivo_accettato");
  if (
    !formalization ||
    formalization.practiceId !== practice.id ||
    formalization.offerRevisionId !== practice.acceptedOfferRevisionId ||
    formalization.offerAcceptanceId !== acceptance?.id ||
    formalization.contractId !== practice.contractId ||
    formalization.signedDocumentVersionId !==
      practice.signedDocumentVersionId ||
    !practice.formalizedAt ||
    !contract ||
    contract.status !== "firmato" ||
    contract.clientId !== practice.clientId ||
    contract.projectId !== practice.projectId ||
    !document ||
    document.deletedAt ||
    !documentVersion ||
    documentVersion.documentId !== document.id
  )
    missing.push("incarico_formalizzato");
  const serviceCompatible = Boolean(
    clientService &&
    serviceRevision &&
    clientService.deletedAt === null &&
    clientService.clientId === practice.clientId &&
    clientService.projectId === practice.projectId &&
    clientService.serviceCatalogId === serviceRevision.serviceCatalogId &&
    clientService.contractId === practice.contractId &&
    (practice.startedAt
      ? clientService.status === "in_lavorazione"
      : clientService.status === "richiesto"),
  );
  if (!serviceCompatible) missing.push("pratica_operativa_collegata");
  return {
    practice,
    missing,
    paid,
    revision,
    acceptance,
    formalization,
    contract,
    documentVersion,
    clientService,
    materialSnapshot,
    materialHash,
    materialRows,
  };
}

export async function startPractice(
  db: Db,
  claimed: AuthSession,
  raw: unknown,
) {
  enabled();
  const input = startSchema.parse(raw);
  await assertSyntheticCatalogDatabase(db);
  return db.$transaction(
    async (tx) => {
      const a = await actor(tx, claimed);
      await practiceScope(tx, a, input.practiceId);
      const state = await resolvePrerequisites(tx, input.practiceId);
      if (
        state.practice.version !== input.expectedVersion ||
        state.practice.startedAt
      )
        throw new PracticeReadinessError("CONFLICT");
      if (state.missing.length) throw new PracticeReadinessError("NOT_READY");
      const evidence = {
        offerRevisionId: state.revision!.id,
        offerSnapshotHash: state.revision!.payloadHash,
        acceptanceId: state.acceptance!.id,
        formalizationId: state.formalization!.id,
        contractId: state.contract!.id,
        signedDocumentVersionId: state.documentVersion!.id,
        clientServiceId: state.clientService!.id,
        fundingIds: state.practice.funding
          .filter((x) => x.status === "CONFIRMED" && !x.successor)
          .map((x) => x.id),
        fundingAmount: state.paid.toFixed(2),
        materialEvidenceIds: state.materialRows.map((x) => x.evidenceId),
        materialSnapshotHash: state.materialHash,
      };
      const startedAt = new Date();
      const service = await tx.clientService.update({
        where: { id: state.clientService!.id },
        data: {
          status: "in_lavorazione",
          operationalStatus: "pre_analisi",
          statusUpdatedAt: startedAt,
        },
      });
      const row = await tx.practiceReadiness.update({
        where: { id: state.practice.id, version: input.expectedVersion },
        data: {
          startedAt,
          startedById: a.userId,
          startEvidence: evidence,
          version: { increment: 1 },
        },
      });
      await tx.auditLog.createMany({
        data: [
          {
            actorId: a.userId,
            event: "practice_started",
            entityType: "PracticeReadiness",
            entityId: row.id,
            after: evidence,
          },
          {
            actorId: a.userId,
            event: "practice_client_service_started",
            entityType: "ClientService",
            entityId: service.id,
            after: {
              practiceId: row.id,
              status: service.status,
              operationalStatus: service.operationalStatus,
            },
          },
        ],
      });
      maybeFailAudit();
      return row;
    },
    { isolationLevel: "Serializable" },
  );
}

const formalizeSchema = z.object({
  practiceId: z.string().uuid(),
  contractId: z.string().min(1).max(191),
  signedDocumentId: z.string().min(1).max(191),
  signedDocumentVersionId: z.string().min(1).max(191),
  expectedVersion: z.coerce.number().int().positive(),
});
const completenessSchema = z.object({
  practiceId: z.string().uuid(),
  expectedVersion: z.coerce.number().int().positive(),
  emptyChecklistReason: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().min(1).max(500).optional().nullable(),
  ),
});
export function parsePracticeMaterialsCompletenessInput(raw: unknown) {
  const parsed = completenessSchema.safeParse(raw);
  if (!parsed.success) throw new PracticeReadinessError("DENIED");
  return parsed.data;
}
export async function formalizePractice(
  db: Db,
  claimed: AuthSession,
  raw: unknown,
) {
  enabled();
  const input = formalizeSchema.parse(raw);
  await assertSyntheticCatalogDatabase(db);
  return db.$transaction(
    async (tx) => {
      const a = await actor(tx, claimed);
      const { practice: p } = await practiceScope(tx, a, input.practiceId);
      const [
        contract,
        document,
        documentVersion,
        acceptedRevision,
        acceptance,
      ] = await Promise.all([
        tx.contract.findUnique({ where: { id: input.contractId } }),
        tx.document.findUnique({ where: { id: input.signedDocumentId } }),
        tx.documentVersion.findUnique({
          where: { id: input.signedDocumentVersionId },
        }),
        tx.practiceOfferRevision.findUnique({
          where: { id: p.acceptedOfferRevisionId },
        }),
        tx.practiceOfferAcceptance.findUnique({
          where: { offerRevisionId: p.acceptedOfferRevisionId },
        }),
      ]);
      if (
        p.version !== input.expectedVersion ||
        p.currentFormalizationId ||
        !contract ||
        contract.clientId !== p.clientId ||
        contract.projectId !== p.projectId ||
        contract.status !== "firmato" ||
        contract.signedDocumentId !== document?.id ||
        !acceptedRevision ||
        !acceptance ||
        contract.totalAmount.toFixed(2) !==
          acceptedRevision.totalAmount.toFixed(2) ||
        !documentVersion ||
        documentVersion.documentId !== document.id ||
        document.deletedAt ||
        document.clientId !== p.clientId ||
        (p.projectId && document.projectId !== p.projectId)
      )
        throw new PracticeReadinessError("DENIED");
      const formalizedAt = new Date();
      const payloadHash = canonicalSha256({
        practiceId: p.id,
        offerRevisionId: acceptedRevision.id,
        offerAcceptanceId: acceptance.id,
        contractId: contract.id,
        signedDocumentId: document.id,
        signedDocumentVersionId: documentVersion.id,
        formalizedAt: formalizedAt.toISOString(),
        formalizedById: a.userId,
      });
      const formalization = await tx.practiceFormalization.create({
        data: {
          practiceId: p.id,
          offerRevisionId: acceptedRevision.id,
          offerAcceptanceId: acceptance.id,
          contractId: contract.id,
          signedDocumentId: document.id,
          signedDocumentVersionId: documentVersion.id,
          formalizedAt,
          formalizedById: a.userId,
          payloadHash,
        },
      });
      const row = await tx.practiceReadiness.update({
        where: { id: p.id, version: input.expectedVersion },
        data: {
          currentFormalizationId: formalization.id,
          contractId: contract.id,
          signedDocumentId: document.id,
          signedDocumentVersionId: documentVersion.id,
          formalizedAt,
          formalizedById: a.userId,
          version: { increment: 1 },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: a.userId,
          event: "practice_formalized",
          entityType: "PracticeReadiness",
          entityId: p.id,
          after: {
            formalizationId: formalization.id,
            contractId: contract.id,
            signedDocumentId: document.id,
            signedDocumentVersionId: documentVersion.id,
            offerRevisionId: acceptedRevision.id,
            offerAcceptanceId: acceptance.id,
          },
        },
      });
      maybeFailAudit();
      return row;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function linkPracticeClientService(
  db: Db,
  claimed: AuthSession,
  raw: unknown,
) {
  enabled();
  const input = linkServiceSchema.parse(raw);
  await assertSyntheticCatalogDatabase(db);
  return db.$transaction(
    async (tx) => {
      const a = await actor(tx, claimed);
      const { practice } = await practiceScope(tx, a, input.practiceId);
      await tx.$queryRaw`SELECT id FROM "ClientService" WHERE id=${input.clientServiceId} FOR UPDATE`;
      const [service, revision] = await Promise.all([
        tx.clientService.findUnique({ where: { id: input.clientServiceId } }),
        tx.serviceCatalogRevision.findUnique({
          where: { id: practice.serviceRevisionId },
        }),
      ]);
      if (
        practice.version !== input.expectedVersion ||
        practice.startedAt ||
        !practice.currentFormalizationId ||
        !service ||
        service.deletedAt ||
        service.clientId !== practice.clientId ||
        service.projectId !== practice.projectId ||
        service.contractId !== practice.contractId ||
        service.status !== "richiesto" ||
        service.operationalStatus !== "nuova" ||
        !revision ||
        service.serviceCatalogId !== revision.serviceCatalogId
      )
        throw new PracticeReadinessError("DENIED");
      const row = await tx.practiceReadiness.update({
        where: { id: practice.id, version: input.expectedVersion },
        data: { clientServiceId: service.id, version: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          actorId: a.userId,
          event: "practice_client_service_linked",
          entityType: "PracticeReadiness",
          entityId: row.id,
          after: {
            clientServiceId: service.id,
            currentFormalizationId: practice.currentFormalizationId,
          },
        },
      });
      maybeFailAudit();
      return row;
    },
    { isolationLevel: "Serializable" },
  );
}
export async function attestPracticeMaterialsComplete(
  db: Db,
  claimed: AuthSession,
  raw: unknown,
) {
  enabled();
  const input = parsePracticeMaterialsCompletenessInput(raw);
  await assertSyntheticCatalogDatabase(db);
  return db.$transaction(
    async (tx) => {
      const a = await actor(tx, claimed);
      await practiceScope(tx, a, input.practiceId);
      const state = await resolvePrerequisites(tx, input.practiceId);
      if (state.practice.version !== input.expectedVersion)
        throw new PracticeReadinessError("CONFLICT");
      if (
        (state.materialRows.length === 0 && !input.emptyChecklistReason) ||
        state.missing.some(
          (item) =>
            item.startsWith("materiale:") || item.startsWith("motivazione:"),
        )
      )
        throw new PracticeReadinessError("NOT_READY");
      const snapshot = {
        items: state.materialRows,
        emptyChecklistReason: state.materialRows.length
          ? null
          : input.emptyChecklistReason,
      };
      const snapshotHash = canonicalSha256(snapshot);
      const attestation = await tx.practiceMaterialAttestation.create({
        data: {
          practiceId: state.practice.id,
          snapshot,
          snapshotHash,
          decidedAt: new Date(),
          decidedById: a.userId,
        },
      });
      const row = await tx.practiceReadiness.update({
        where: { id: state.practice.id, version: input.expectedVersion },
        data: {
          materialsCompleteAt: new Date(),
          materialsCompleteById: a.userId,
          materialsCompleteEvidenceId: attestation.id,
          version: { increment: 1 },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: a.userId,
          event: "practice_materials_complete",
          entityType: "PracticeReadiness",
          entityId: row.id,
          after: { attestationId: attestation.id, snapshotHash },
        },
      });
      maybeFailAudit();
      return row;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function listAccessiblePracticeReadiness(
  db: Db,
  claimed: AuthSession,
) {
  enabled();
  await assertSyntheticCatalogDatabase(db);
  return db.$transaction(
    async (tx) => {
      const a = await actor(tx, claimed, "service.read");
      const rows = await tx.practiceReadiness.findMany({
        include: {
          funding: true,
          materials: true,
          formalizations: { orderBy: { formalizedAt: "desc" } },
        },
        orderBy: { createdAt: "desc" },
      });
      const visible = [];
      for (const row of rows) {
        try {
          await practiceScope(tx, a, row.id, false);
          const prerequisites = await resolvePrerequisites(tx, row.id);
          visible.push({
            ...row,
            prerequisites: {
              missing: prerequisites.missing,
              availableFunding: prerequisites.paid.toFixed(2),
            },
          });
        } catch (error) {
          if (
            !(
              error instanceof PracticeReadinessError && error.code === "DENIED"
            )
          )
            throw error;
        }
      }
      return visible;
    },
    { isolationLevel: "Serializable" },
  );
}
