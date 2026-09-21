import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { signSessionCookie } from "../../src/lib/session";
import { join } from "node:path";
import {
  expect,
  test,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertSyntheticCatalogDatabase } from "../../src/lib/service-catalog-v2-persistence";
import { cases } from "./fixtures";

const app = "http://127.0.0.1:3000";
const password = process.env.PRACTICE_READINESS_BROWSER_PASSWORD!;
const evidenceDir = process.env.PRACTICE_READINESS_BROWSER_EVIDENCE_DIR!;
const db = new PrismaClient();
type CapturedAction = {
  url: string;
  nextAction: string;
  contentType: string;
  body: string;
};
let currentPhase = "INITIAL";

function docxDocumentXml(bytes: Buffer) {
  // Read the actual document entry, including compressed ZIP entries.
  for (let offset = 0; offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50;) {
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const length = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    if (flags & 8) throw new Error("Unexpected ZIP data descriptor");
    if (bytes.subarray(offset + 30, offset + 30 + nameLength).toString() === "word/document.xml") {
      const entry = bytes.subarray(start, start + length);
      if (method === 0) return entry.toString("utf8");
      if (method === 8) return inflateRawSync(entry).toString("utf8");
      throw new Error("Unsupported DOCX compression");
    }
    offset = start + length;
  }
  throw new Error("DOCX document XML missing");
}

async function expectDossierAbsentFromIndex(page: Page, dossier: { id: string; title: string }) {
  const response = await page.goto(`${app}/client-dossiers`);
  expect(response?.status()).toBe(200);
  const html = await response!.text();
  expect(html).not.toContain(dossier.title);
  expect(html).not.toContain(`/client-dossiers/${dossier.id}`);
  await expect(page.locator(`a[href="/client-dossiers/${dossier.id}"]`)).toHaveCount(0);
}

async function submitDossierAction(page: Page, button: Locator, phase: string) {
  currentPhase = phase;
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && Boolean(response.request().headers()["next-action"]));
  await button.click();
  const response = await responsePromise;
  await response.finished();
  expect(response.status(), phase).toBe(200);
  expect(response.headers()["x-action-redirect"] ?? "", phase).not.toContain("dossierError=");
}

async function submitAction(
  page: Page,
  button: Locator,
  phase: string,
  expected: "SUCCESS" | "NOT_READY" | "CONFLICT" = "SUCCESS",
) {
  currentPhase = phase;
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "POST" && Boolean(request.headers()["next-action"])
    );
  });
  await button.click();
  const response = await responsePromise;
  expect(response.status(), `${phase}: HTTP Next action`).toBe(200);
  const redirect = response.headers()["x-action-redirect"];
  expect(redirect, `${phase}: x-action-redirect`).toBeTruthy();
  const destination = new URL(redirect!.split(";", 1)[0], app);
  expect(destination.pathname, `${phase}: destinazione`).toBe(
    "/practice-readiness",
  );
  if (expected === "SUCCESS")
    expect(
      destination.searchParams.get("updated"),
      `${phase}: receipt`,
    ).toBeTruthy();
  else
    expect(destination.searchParams.get("error"), `${phase}: errore`).toBe(
      expected,
    );
  await expect(page, `${phase}: navigazione corrente`).toHaveURL(
    destination.href,
  );
  return response;
}

async function login(page: Page, email: string) {
  await page.goto(`${app}/login`);
  await page
    .locator('[data-interactive-ready="true"]')
    .waitFor({ state: "attached" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login interno" }).click();
  await expect(page).toHaveURL(`${app}/dashboard`);
}

async function reloadPractice(page: Page, practiceId: string) {
  await page.goto(`${app}/practice-readiness`);
  await page
    .locator('[data-interactive-ready="true"]')
    .waitFor({ state: "attached" });
  const article = page.locator(`#practice-${practiceId}`);
  await expect(article).toBeVisible();
  return article;
}

async function expectDenied(response: APIResponse) {
  expect(response.status()).toBe(200);
  const redirect = response.headers()["x-action-redirect"];
  expect(redirect).toBeTruthy();
  expect(new URL(redirect!.split(";", 1)[0], app).href).toBe(
    `${app}/dashboard`,
  );
}

async function readinessFootprint() {
  const where = { clientId: { startsWith: "readiness-browser-client-" } };
  const practices = await db.practiceReadiness.findMany({
    where,
    include: {
      funding: { orderBy: [{ reference: "asc" }, { sequence: "asc" }] },
      materials: { orderBy: [{ checklistItemId: "asc" }, { sequence: "asc" }] },
      materialAttestations: { orderBy: { decidedAt: "asc" } },
      formalizations: { orderBy: { formalizedAt: "asc" } },
    },
    orderBy: { clientId: "asc" },
  });
  const services = await db.clientService.findMany({
    where: { clientId: { startsWith: "readiness-browser-client-" } },
    orderBy: { clientId: "asc" },
  });
  return { practices, services };
}

test.beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  await assertSyntheticCatalogDatabase(db);
});
test.afterAll(() => db.$disconnect());
test.afterEach(async ({}, info) => {
  writeFileSync(
    join(evidenceDir, `browser-${info.status}.json`),
    JSON.stringify({
      stage: "browser",
      status: info.status,
      expectedStatus: info.expectedStatus,
      synthetic: true,
      phase: currentPhase,
    }) + "\n",
    { mode: 0o600 },
  );
});

test("standard, quote-only and forming-subject paths reach an explicit synchronized start", async ({
  browser,
}) => {
  const anonymous = await browser.newPage();
  await anonymous.goto(`${app}/practice-readiness`);
  await expect(anonymous).toHaveURL(`${app}/login`);
  await anonymous.close();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: "Europe/Rome",
  });
  expect(process.env.TZ).toBe("UTC");
  const page = await context.newPage();
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("Europe/Rome");
  await login(page, "readiness-owner@invalid.test");
  await page.goto(`${app}/practice-readiness`);
  await page
    .locator('[data-interactive-ready="true"]')
    .waitFor({ state: "attached" });
  expect(await page.content()).not.toContain(
    "readiness-browser-sensitive-history-checklist",
  );
  expect(await page.content()).not.toContain(
    "readiness-browser-sensitive-history-version",
  );
  for (const reservedValue of [
    "Requisito storico strettamente riservato",
    "Motivazione storica strettamente riservata",
    "Motivazione con versione sensibile da non esporre",
  ])
    await expect(page.getByText(reservedValue, { exact: false })).toHaveCount(0);
  await expect(
    page.getByText("materiale_riservato", { exact: false }),
  ).toBeVisible();
  let capturedStart: CapturedAction | null = null;
  const dossierIds: string[] = [];

  for (const item of cases) {
    await page.goto(`${app}/clients/readiness-browser-client-${item.key}`);
    await expect(
      page.getByRole("link", { name: "Pratiche da preventivo ad avvio" }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Pratiche da preventivo ad avvio" })
      .click();
    await expect(page).toHaveURL(`${app}/practice-readiness`);

    const scope = `Perimetro browser ${item.label}`;
    const open = page
      .getByRole("heading", { name: "Apri pratica controllata" })
      .locator("xpath=ancestor::section[1]");
    await open
      .locator('[name="controlledIntakeId"]')
      .selectOption({ label: `browser-${item.key}` });
    const offerSelect = open.locator('[name="commercialOfferSelection"]');
    const offerValue = await offerSelect
      .locator("option")
      .filter({ hasText: `Preventivo ${item.label}` })
      .getAttribute("value");
    expect(offerValue).toBeTruthy();
    await offerSelect.selectOption(offerValue!);
    const revision = await db.serviceCatalogRevision.findFirstOrThrow({
      where: {
        serviceCatalog: { code: item.serviceCode },
        status: "PUBLISHED",
      },
      orderBy: { version: "desc" },
    });
    await open.locator('[name="serviceRevisionId"]').selectOption(revision.id);
    await open
      .locator('[name="clientId"]')
      .selectOption(`readiness-browser-client-${item.key}`);
    await open
      .locator('[name="projectId"]')
      .selectOption(`readiness-browser-project-${item.key}`);
    await open
      .locator('[name="digitalProjectType"]')
      .selectOption(item.key === "forming" ? "software_crm_workflow" : "");
    await open.locator('[name="scope"]').fill(scope);
    await open
      .locator('[name="startupConditions"]')
      .fill("Avvio dopo incarico, accredito e materiali verificati");
    await open.locator('[name="requiredInitialAmount"]').fill("50.00");
    await submitAction(
      page,
      open.getByRole("button", { name: "Crea revisione preventivo" }),
      `${item.key}:proposta`,
    );

    const proposal = await db.practiceOfferRevision.findFirstOrThrow({
      where: { commercialOfferId: `readiness-browser-offer-${item.key}` },
      orderBy: { revision: "desc" },
    });
    const proposalCard = page
      .getByText(scope, { exact: false })
      .locator("xpath=ancestor::article[1]");
    await submitAction(
      page,
      proposalCard.getByRole("button", { name: "Accetta questa revisione" }),
      `${item.key}:accettazione`,
    );
    const practice = await db.practiceReadiness.findUniqueOrThrow({
      where: { controlledIntakeId: proposal.controlledIntakeId },
    });
    await expect(page.locator(`#practice-${practice.id}`)).toBeVisible();

    let article = await reloadPractice(page, practice.id);
    await expect(
      article.locator(
        `option[value="readiness-browser-sensitive-document-${item.key}"]`,
      ),
    ).toHaveCount(0);
    await expect(
      article.getByText(`Documento sensibile ${item.label}`, { exact: false }),
    ).toHaveCount(0);
    await article
      .locator('[name="contractId"]')
      .selectOption(`readiness-browser-contract-${item.key}`);
    await article
      .locator('[name="signedDocumentId"]')
      .selectOption(`readiness-browser-document-${item.key}`);
    const documentVersion = await db.documentVersion.findFirstOrThrow({
      where: { documentId: `readiness-browser-document-${item.key}` },
      orderBy: { version: "desc" },
    });
    await article
      .locator('[name="signedDocumentVersionId"]')
      .selectOption(documentVersion.id);
    await submitAction(
      page,
      article.getByRole("button", { name: "Conferma incarico formalizzato" }),
      `${item.key}:formalizzazione`,
    );
    await expect(page.locator(`#practice-${practice.id}`).getByText(documentVersion.id, { exact: false })).toBeVisible();

    article = await reloadPractice(page, practice.id);
    await article
      .locator('[name="clientServiceId"]')
      .selectOption(`readiness-browser-service-${item.key}`);
    await submitAction(
      page,
      article.getByRole("button", {
        name: "Collega pratica operativa in attesa",
      }),
      `${item.key}:collegamento-servizio`,
    );
    await expect(page.locator(`#practice-${practice.id}`).getByText(`readiness-browser-service-${item.key}`, { exact: false })).toBeVisible();
    expect(
      (
        await db.clientService.findUniqueOrThrow({
          where: { id: `readiness-browser-service-${item.key}` },
        })
      ).status,
    ).toBe("richiesto");

    const payments = item.partial
      ? [
          ["20.00", "prima"],
          ["30.00", "integrazione"],
        ]
      : [["50.00", "unico"]];
    let stalePage: Page | null = null;
    for (const [amount, part] of payments) {
      article = await reloadPractice(page, practice.id);
      const reference = `ACC-${item.key}-${part}`;
      await article.locator('[name="reference"]').fill(reference);
      await article.locator('[name="amount"]').fill(amount);
      await submitAction(
        page,
        article.getByRole("button", { name: "Dichiara accredito" }),
        `${item.key}:accredito-${part}-dichiarato`,
      );
      const declared = await db.practiceFundingEvidence.findFirstOrThrow({
        where: {
          practiceId: practice.id,
          reference,
          amount,
          currency: "EUR",
          status: "DECLARED",
          successor: null,
        },
        orderBy: { createdAt: "desc" },
      });
      const declaredRow = page.locator(
        `[data-funding-evidence-id="${declared.id}"]`,
      );
      await expect(declaredRow).toHaveAttribute(
        "data-funding-reference",
        reference,
      );
      await expect(declaredRow).toHaveAttribute(
        "data-funding-status",
        "DECLARED",
      );
      await expect(declaredRow).toContainText(
        `${reference} · € ${amount} · DECLARED`,
      );
      article = await reloadPractice(page, practice.id);
      const funding = article.locator(
        `[data-funding-evidence-id="${declared.id}"]`,
      );
      await submitAction(
        page,
        funding.getByRole("button", { name: "Conferma accredito" }),
        `${item.key}:accredito-${part}-confermato`,
      );
      const confirmed = await db.practiceFundingEvidence.findFirstOrThrow({
        where: {
          practiceId: practice.id,
          predecessorId: declared.id,
          reference,
          amount,
          currency: "EUR",
          status: "CONFIRMED",
          successor: null,
        },
      });
      const confirmedRow = page.locator(
        `[data-funding-evidence-id="${confirmed.id}"]`,
      );
      await expect(confirmedRow).toHaveAttribute(
        "data-funding-reference",
        reference,
      );
      await expect(confirmedRow).toHaveAttribute(
        "data-funding-status",
        "CONFIRMED",
      );
      await expect(confirmedRow).toContainText(
        `${reference} · € ${amount} · CONFIRMED`,
      );
      if (item.partial && part === "prima") {
        article = await reloadPractice(page, practice.id);
        await submitAction(
          page,
          article.getByRole("button", { name: "Avvia esplicitamente" }),
          `${item.key}:avvio-parziale-negato`,
          "NOT_READY",
        );
        await expect(page.locator('p[role="alert"]')).toContainText("NOT_READY");
        expect(
          (
            await db.practiceReadiness.findUniqueOrThrow({
              where: { id: practice.id },
            })
          ).startedAt,
        ).toBeNull();
        stalePage = await context.newPage();
        await reloadPractice(stalePage, practice.id);
      }
      if (item.partial && part === "integrazione" && stalePage) {
        const staleArticle = stalePage.locator(`#practice-${practice.id}`);
        await staleArticle
          .locator('[name="reference"]')
          .fill("ACC-standard-obsoleto");
        await staleArticle.locator('[name="amount"]').fill("1.00");
        await submitAction(
          stalePage,
          staleArticle.getByRole("button", { name: "Dichiara accredito" }),
          `${item.key}:modulo-obsoleto`,
          "CONFLICT",
        );
        await expect(stalePage.locator('p[role="alert"]')).toContainText("CONFLICT");
        await expect(
          stalePage.locator(`#practice-${practice.id} [name="reference"]`),
        ).toHaveValue("ACC-standard-obsoleto");
        await expect(
          stalePage.locator(`#practice-${practice.id} [name="amount"]`),
        ).toHaveValue("1.00");
        await stalePage.close();
      }
    }

    article = await reloadPractice(page, practice.id);
    await article
      .locator('[name="checklistItemId"]')
      .selectOption(`readiness-browser-checklist-${item.key}`);
    const materialForm = article
      .getByRole("button", {
        name: "Registra decisione materiale",
        exact: true,
      })
      .locator("xpath=ancestor::form[1]");
    await expect(materialForm).toBeVisible();
    await expect(materialForm.locator('[name="documentId"]')).toHaveCount(1);
    await expect(
      materialForm.locator('[name="documentVersionId"]'),
    ).toHaveCount(1);
    await materialForm
      .locator('[name="documentId"]')
      .selectOption(`readiness-browser-document-${item.key}`);
    await materialForm
      .locator('[name="documentVersionId"]')
      .selectOption(documentVersion.id);
    await article.locator('[name="status"]').selectOption("VALIDATED");
    await submitAction(
      page,
      article.getByRole("button", { name: "Registra decisione materiale" }),
      `${item.key}:materiale-validato`,
    );
    let materialDecision =
      await db.practiceMaterialEvidence.findFirstOrThrow({
        where: {
          practiceId: practice.id,
          checklistItemId: `readiness-browser-checklist-${item.key}`,
          documentVersionId: documentVersion.id,
          status: "VALIDATED",
          successor: null,
        },
        orderBy: { sequence: "desc" },
      });
    let materialRow = page.locator(
      `[data-material-evidence-id="${materialDecision.id}"]`,
    );
    await expect(materialRow).toHaveAttribute(
      "data-material-checklist-item-id",
      `readiness-browser-checklist-${item.key}`,
    );
    await expect(materialRow).toHaveAttribute(
      "data-material-status",
      "VALIDATED",
    );
    await expect(materialRow).toHaveAttribute(
      "data-material-sequence",
      String(materialDecision.sequence),
    );
    await expect(materialRow).toContainText(documentVersion.id);
    article = await reloadPractice(page, practice.id);
    await expect(
      article.locator('[name="emptyChecklistReason"]'),
    ).toHaveValue("");
    await submitAction(
      page,
      article.getByRole("button", { name: "Attesta materiali completi" }),
      `${item.key}:completezza`,
    );

    if (item.key === "standard") {
      article = await reloadPractice(page, practice.id);
      await article
        .locator('[name="checklistItemId"]')
        .selectOption(`readiness-browser-checklist-${item.key}`);
      await article.locator('[name="status"]').selectOption("INVALIDATED");
      await article
        .locator('[name="reason"]')
        .fill("Versione sostituita durante la verifica browser");
      await submitAction(
        page,
        article.getByRole("button", { name: "Registra decisione materiale" }),
        `${item.key}:materiale-invalidato`,
      );
      materialDecision =
        await db.practiceMaterialEvidence.findFirstOrThrow({
          where: {
            practiceId: practice.id,
            checklistItemId: `readiness-browser-checklist-${item.key}`,
            status: "INVALIDATED",
            successor: null,
          },
          orderBy: { sequence: "desc" },
        });
      materialRow = page.locator(
        `[data-material-evidence-id="${materialDecision.id}"]`,
      );
      await expect(materialRow).toHaveAttribute(
        "data-material-status",
        "INVALIDATED",
      );
      await expect(materialRow).toContainText(
        "Versione sostituita durante la verifica browser",
      );
      article = await reloadPractice(page, practice.id);
      await submitAction(
        page,
        article.getByRole("button", { name: "Avvia esplicitamente" }),
        `${item.key}:avvio-materiale-negato`,
        "NOT_READY",
      );
      await expect(page.locator('p[role="alert"]')).toContainText("NOT_READY");
      article = await reloadPractice(page, practice.id);
      await article
        .locator('[name="checklistItemId"]')
        .selectOption(`readiness-browser-checklist-${item.key}`);
      const replacementMaterialForm = article
        .getByRole("button", {
          name: "Registra decisione materiale",
          exact: true,
        })
        .locator("xpath=ancestor::form[1]");
      await expect(replacementMaterialForm).toBeVisible();
      await expect(
        replacementMaterialForm.locator('[name="documentId"]'),
      ).toHaveCount(1);
      await expect(
        replacementMaterialForm.locator('[name="documentVersionId"]'),
      ).toHaveCount(1);
      await replacementMaterialForm
        .locator('[name="documentId"]')
        .selectOption(`readiness-browser-document-${item.key}`);
      await replacementMaterialForm
        .locator('[name="documentVersionId"]')
        .selectOption(documentVersion.id);
      await replacementMaterialForm
        .locator('[name="status"]')
        .selectOption("VALIDATED");
      await submitAction(
        page,
        article.getByRole("button", { name: "Registra decisione materiale" }),
        `${item.key}:materiale-rivalidato`,
      );
      materialDecision =
        await db.practiceMaterialEvidence.findFirstOrThrow({
          where: {
            practiceId: practice.id,
            checklistItemId: `readiness-browser-checklist-${item.key}`,
            documentVersionId: documentVersion.id,
            status: "VALIDATED",
            successor: null,
          },
          orderBy: { sequence: "desc" },
        });
      materialRow = page.locator(
        `[data-material-evidence-id="${materialDecision.id}"]`,
      );
      await expect(materialRow).toHaveAttribute(
        "data-material-status",
        "VALIDATED",
      );
      await expect(materialRow).toHaveAttribute(
        "data-material-sequence",
        String(materialDecision.sequence),
      );
      await expect(materialRow).toContainText(documentVersion.id);
      article = await reloadPractice(page, practice.id);
      await expect(
        article.locator('[name="emptyChecklistReason"]'),
      ).toHaveValue("");
      await submitAction(
        page,
        article.getByRole("button", { name: "Attesta materiali completi" }),
        `${item.key}:completezza-rinnovata`,
      );
    }

    article = await reloadPractice(page, practice.id);
    page.on("request", (request) => {
      const headers = request.headers();
      if (
        !capturedStart &&
        request.method() === "POST" &&
        headers["next-action"] &&
        request.postData()?.includes(practice.id)
      ) {
        capturedStart = {
          url: request.url(),
          nextAction: headers["next-action"],
          contentType: headers["content-type"] ?? "",
          body: request.postData() ?? "",
        };
      }
    });
    await submitAction(
      page,
      article.getByRole("button", { name: "Avvia esplicitamente" }),
      `${item.key}:avvio`,
    );
    article = await reloadPractice(page, practice.id);
    await expect(article.getByText("avviata")).toBeVisible();

    const persisted = await db.practiceReadiness.findUniqueOrThrow({
      where: { id: practice.id },
      include: { formalizations: true, funding: true, materials: true },
    });
    const startEvidence = persisted.startEvidence as {
      formalizationId: string;
      clientServiceId: string;
      signedDocumentVersionId: string;
      fundingAmount: string;
    };
    expect(persisted.formalizations).toHaveLength(1);
    expect(persisted.currentFormalizationId).toBe(
      persisted.formalizations[0].id,
    );
    expect(startEvidence.formalizationId).toBe(
      persisted.currentFormalizationId,
    );
    expect(startEvidence.clientServiceId).toBe(
      `readiness-browser-service-${item.key}`,
    );
    expect(startEvidence.signedDocumentVersionId).toBe(documentVersion.id);
    expect(startEvidence.fundingAmount).toBe("50.00");
    expect(
      (
        await db.clientService.findUniqueOrThrow({
          where: { id: startEvidence.clientServiceId },
        })
      ).status,
    ).toBe("in_lavorazione");

    if (item.key === "standard") {
      const historicalStart = {
        startedAt: persisted.startedAt?.toISOString(),
        startedById: persisted.startedById,
        startEvidence: persisted.startEvidence,
      };
      article = await reloadPractice(page, practice.id);
      const confirmedFundingEvidence =
        await db.practiceFundingEvidence.findFirstOrThrow({
          where: {
            practiceId: practice.id,
            reference: "ACC-standard-prima",
            status: "CONFIRMED",
            successor: null,
          },
        });
      const confirmedFunding = article.locator(
        `[data-funding-evidence-id="${confirmedFundingEvidence.id}"]`,
      );
      await expect(confirmedFunding).toHaveAttribute(
        "data-funding-status",
        "CONFIRMED",
      );
      await submitAction(
        page,
        confirmedFunding.getByRole("button", { name: "Rettifica / storna" }),
        "standard:storno-post-avvio",
      );
      article = await reloadPractice(page, practice.id);
      await expect(
        article.getByText("accredito_iniziale", { exact: false }),
      ).toBeVisible();
      const incoherent = await db.practiceReadiness.findUniqueOrThrow({
        where: { id: practice.id },
      });
      expect(incoherent.startedAt?.toISOString()).toBe(
        historicalStart.startedAt,
      );
      expect(incoherent.startedById).toBe(historicalStart.startedById);
      expect(incoherent.startEvidence).toEqual(historicalStart.startEvidence);
      await expect(article.getByText("avviata")).toBeVisible();
    }

    await page.goto(`${app}/practice-readiness`);
    const startedArticle = page.locator(`#practice-${practice.id}`);
    await startedArticle
      .getByRole("link", { name: "Preanalisi → dossier e consegna" })
      .click();
    await expect(page).toHaveURL(`${app}/engagement-dossiers/new/${practice.id}`);
    await page.locator('[name="preAnalysisId"]').selectOption(`readiness-browser-preanalysis-${item.key}`);
    await page.locator('[name="title"]').fill(`Dossier browser ${item.label}`);
    await page.locator('[name="content"]').fill(`Versione iniziale browser ${item.label}`);
    await submitDossierAction(page, page.getByRole("button", { name: "Crea dossier versionato" }), `DOSSIER_CREATE_${item.key}`);
    await expect(page).toHaveURL(/\/client-dossiers\//);
    const dossier = await db.clientDossier.findUniqueOrThrow({ where: { practiceReadinessId: practice.id } });
    dossierIds.push(dossier.id);
    await expect(page.getByText("Versione 1", { exact: false })).toBeVisible();
    for (const format of ["", "/docx"]) {
      const draftExport = await page.request.get(`${app}/client-dossiers/${dossier.id}/export${format}?versionId=${dossier.currentVersionId}`);
      expect(draftExport.status()).toBe(403);
      expect(await draftExport.text()).not.toContain(`Versione iniziale browser ${item.label}`);
    }
  }

  expect(capturedStart).not.toBeNull();
  const reviewerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const reviewerPage = await reviewerContext.newPage();
  await login(reviewerPage, "readiness-reader@invalid.test");
  for (const [index, dossierId] of dossierIds.entries()) {
    await reviewerPage.goto(`${app}/client-dossiers/${dossierId}`);
    await reviewerPage.getByPlaceholder("Motivazione della decisione").fill(index === 0 ? "Correggere la prima versione" : "Versione verificata");
    await submitDossierAction(reviewerPage, reviewerPage.getByRole("button", { name: index === 0 ? "Richiedi modifiche" : "Approva questa versione" }), `DOSSIER_REVIEW_${index}`);
  }
  await page.goto(`${app}/client-dossiers/${dossierIds[0]}`);
  await page.locator('form').filter({ has: page.getByRole('button', { name: 'Salva come nuova versione' }) }).locator('[name="content"]').fill("Versione corretta dopo richiesta modifiche");
  await submitDossierAction(page, page.getByRole("button", { name: "Salva come nuova versione" }), "DOSSIER_CORRECTION");
  const corrected = await db.clientDossier.findUniqueOrThrow({ where: { id: dossierIds[0] } });
  await reviewerPage.goto(`${app}/client-dossiers/${dossierIds[0]}`);
  await reviewerPage.getByPlaceholder("Motivazione della decisione").fill("Versione corretta approvata");
  await submitDossierAction(reviewerPage, reviewerPage.getByRole("button", { name: "Approva questa versione" }), "DOSSIER_APPROVE_CORRECTION");
  expect((await db.clientDossier.findUniqueOrThrow({ where: { id: corrected.id } })).approvedVersionId).toBeTruthy();

  for (const [index, dossierId] of dossierIds.entries()) {
    await page.goto(`${app}/client-dossiers/${dossierId}`);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Esporta approvato .md' }).click();
    expect((await downloadPromise).suggestedFilename()).toContain('.md');
    const approved = await db.clientDossier.findUniqueOrThrow({ where: { id: dossierId } });
    const version = await db.engagementDossierVersion.findUniqueOrThrow({ where: { id: approved.approvedVersionId! } });
    const clientBeforeExport = await db.client.findUniqueOrThrow({ where: { id: approved.clientId } });
    const unapprovedName = `ANAGRAFICA NON APPROVATA ${index}`;
    const unapprovedNote = `NOTA NON APPROVATA ${index}`;
    await db.client.update({ where: { id: approved.clientId }, data: { displayName: unapprovedName, notes: unapprovedNote } });
    try {
      for (const [suffix, format] of [["", "markdown"], ["/docx", "docx"]] as const) {
        const exported = await page.request.get(`${app}/client-dossiers/${dossierId}/export${suffix}?versionId=${version.id}`);
        expect(exported.status()).toBe(200);
        const bytes = await exported.body();
        expect(exported.headers()["x-dossier-content-hash"]).toBe(version.contentHash);
        if (format === "markdown") expect(bytes.toString("utf8")).toBe(version.content);
        else {
          const xml = docxDocumentXml(bytes);
          expect(xml).toContain(version.title);
          expect(xml).toContain(version.content);
          for (const excluded of [unapprovedName, unapprovedNote, "Dati cliente", "Tipologia cliente:", "Stato cliente:", "Stato bozza:"])
            expect(xml).not.toContain(excluded);
        }
        const record = await db.engagementDossierExport.findFirstOrThrow({ where: { dossierId, versionId: version.id, format }, orderBy: { exportedAt: "desc" } });
        expect(record.versionHash).toBe(version.contentHash);
        expect(record.artifactHash).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
    } finally {
      await db.client.update({ where: { id: approved.clientId }, data: { displayName: clientBeforeExport.displayName, notes: clientBeforeExport.notes } });
    }
    await page.goto(`${app}/client-dossiers/${dossierId}`);
    const authorizationForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Autorizza consegna manuale' }) });
    await authorizationForm.locator('[name="recipientName"]').fill(`Destinatario sintetico ${index + 1}`);
    await authorizationForm.locator('[name="recipientAddress"]').fill(`destinatario-${index + 1}@invalid.test`);
    await authorizationForm.locator('[name="recipientSynthetic"]').check();
    await submitDossierAction(page, page.getByRole('button', { name: 'Autorizza consegna manuale' }), `DOSSIER_AUTHORIZE_${index}`);
    const authorization = await db.engagementDossierDeliveryAuthorization.findFirstOrThrow({ where: { dossierId }, orderBy: { authorizedAt: 'desc' } });
    await page.goto(`${app}/client-dossiers/${dossierId}`);
    const receiptForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Registra esito manuale' }) });
    await receiptForm.locator('[name="reference"]').fill(`RICEVUTA-BROWSER-${index + 1}`);
    await expect(receiptForm.getByText("Data e ora della consegna (Europe/Rome)")).toBeVisible();
    await receiptForm.locator('[name="deliveredAtLocal"]').fill('2026-09-20T12:00');
    await expect(receiptForm.locator('[name="deliveredAt"]')).toHaveValue('2026-09-20T10:00:00.000Z');
    await receiptForm.locator('[name="evidenceSynthetic"]').check();
    const receiptRequestPromise = page.waitForRequest((request) => request.method() === "POST" && Boolean(request.headers()["next-action"]));
    await submitDossierAction(page, page.getByRole('button', { name: 'Registra esito manuale' }), `DOSSIER_RECEIPT_${index}`);
    const receiptRequest = await receiptRequestPromise;
    const recorded = await db.engagementDossierDeliveryReceipt.findUniqueOrThrow({ where: { authorizationId: authorization.id } });
    expect(recorded.outcome).toBe('DELIVERED');
    expect((recorded.evidence as { deliveredAt: string }).deliveredAt).toBe('2026-09-20T10:00:00.000Z');
    const auditCount = await db.auditLog.count({ where: { entityId: dossierId, event: "engagement_dossier_delivery_record" } });
    const replay = await page.request.fetch(receiptRequest.url(), {
      method: "POST", headers: { "next-action": receiptRequest.headers()["next-action"], "content-type": receiptRequest.headers()["content-type"], origin: app, referer: `${app}/client-dossiers/${dossierId}` },
      data: receiptRequest.postDataBuffer()!, maxRedirects: 0,
    });
    expect(replay.status()).toBe(200);
    expect(replay.headers()["x-action-redirect"] ?? "").not.toContain("dossierError=");
    expect(await db.engagementDossierDeliveryReceipt.findUniqueOrThrow({ where: { authorizationId: authorization.id } })).toEqual(recorded);
    expect(await db.engagementDossierDeliveryReceipt.count({ where: { authorizationId: authorization.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: dossierId, event: "engagement_dossier_delivery_record" } })).toBe(auditCount);
  }

  const protectedDossier = await db.clientDossier.findUniqueOrThrow({ where: { id: dossierIds[0] } });
  const legacy = await db.clientDossier.create({ data: {
    clientId: protectedDossier.clientId, projectId: protectedDossier.projectId,
    clientServiceId: protectedDossier.clientServiceId, type: "dossier_cliente",
    title: "Fixture legacy sintetica", content: "Contenuto legacy sintetico", createdById: "readiness-browser-owner",
  } });
  for (const [actorPage, buttonName] of [[page, "Salva modifiche"], [reviewerPage, "Conferma revisione dossier"]] as const) {
    await actorPage.goto(`${app}/client-dossiers/${legacy.id}`);
    const form = actorPage.locator("form").filter({ has: actorPage.getByRole("button", { name: buttonName }) });
    await form.locator('[name="id"]').evaluate((node, id) => { (node as HTMLInputElement).value = id; }, protectedDossier.id);
    const before = await db.clientDossier.findUniqueOrThrow({ where: { id: protectedDossier.id } });
    const auditCount = await db.auditLog.count({ where: { entityType: "ClientDossier", entityId: protectedDossier.id } });
    const responsePromise = actorPage.waitForResponse((response) => response.request().method() === "POST" && Boolean(response.request().headers()["next-action"]));
    await form.getByRole("button", { name: buttonName }).click();
    const response = await responsePromise;
    await response.finished();
    // A streamed RSC response can carry the server error after HTTP 200 headers.
    // Assert the manipulated target and explicit denial, not only transport status.
    expect([200, 500]).toContain(response.status());
    expect(response.request().postData()).toContain(protectedDossier.id);
    expect(await response.text()).toContain(buttonName === "Salva modifiche"
      ? "Usa le azioni della versione esatta del dossier."
      : "Usa la revisione della versione esatta del dossier.");
    expect(await db.clientDossier.findUniqueOrThrow({ where: { id: protectedDossier.id } })).toEqual(before);
    expect(await db.auditLog.count({ where: { entityType: "ClientDossier", entityId: protectedDossier.id } })).toBe(auditCount);
  }
  await reviewerContext.close();

  const protectedVersion = await db.engagementDossierVersion.findUniqueOrThrow({ where: { id: protectedDossier.approvedVersionId! } });
  const materialId = (protectedVersion.materialSnapshot as Array<{ documentId: string | null }>).find((row) => row.documentId)?.documentId;
  expect(materialId).toBeTruthy();
  await db.document.update({ where: { id: materialId! }, data: { containsSensitiveData: true } });
  try {
    await expectDossierAbsentFromIndex(page, protectedDossier);
    await page.goto(`${app}/client-dossiers/${protectedDossier.id}`);
    await expect(page.getByText("Bozza dossier non trovata", { exact: true })).toBeVisible();
    expect(await page.content()).not.toContain(protectedVersion.content);
    for (const format of ["", "/docx"]) expect((await page.request.get(`${app}/client-dossiers/${protectedDossier.id}/export${format}?versionId=${protectedVersion.id}`)).status()).toBe(404);
  } finally { await db.document.update({ where: { id: materialId! }, data: { containsSensitiveData: false } }); }

  await db.clientDossier.update({ where: { id: protectedDossier.id }, data: { status: "archiviata" } });
  try { await expectDossierAbsentFromIndex(page, protectedDossier); }
  finally { await db.clientDossier.update({ where: { id: protectedDossier.id }, data: { status: protectedDossier.status } }); }
  await page.goto(`${app}/client-dossiers`);
  await expect(page.locator(`a[href="/client-dossiers/${protectedDossier.id}"]`)).toBeVisible();

  const nonCanonical = await browser.newContext();
  await nonCanonical.addCookies([{
    name: process.env.AUTH_COOKIE_NAME!, url: app,
    value: await signSessionCookie({ userId: "readiness-browser-owner", expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
  }]);
  const nonCanonicalPage = await nonCanonical.newPage();
  const deniedIndex = await nonCanonicalPage.request.get(`${app}/client-dossiers`, { maxRedirects: 0 });
  expect([303, 307]).toContain(deniedIndex.status());
  expect(new URL(deniedIndex.headers().location, app).pathname).toBe("/login");
  expect(await deniedIndex.text()).not.toContain(protectedDossier.title);
  expect(await deniedIndex.text()).not.toContain(`/client-dossiers/${protectedDossier.id}`);
  await nonCanonicalPage.goto(`${app}/client-dossiers`);
  await expect(nonCanonicalPage).toHaveURL(`${app}/login`);
  expect(await nonCanonicalPage.content()).not.toContain(protectedDossier.title);
  await nonCanonical.close();

  const foreign = await browser.newContext();
  const foreignPage = await foreign.newPage();
  await login(foreignPage, "readiness-foreign@invalid.test");
  await foreignPage.goto(`${app}/practice-readiness`);
  await foreignPage
    .locator('[data-interactive-ready="true"]')
    .waitFor({ state: "attached" });
  await expect(foreignPage.getByText("Nessuna pratica")).toBeVisible();
  for (const item of cases) {
    await expect(
      foreignPage.getByText(`Cliente ${item.label}`, { exact: false }),
    ).toHaveCount(0);
    await expect(
      foreignPage.getByText(`Perimetro browser ${item.label}`, {
        exact: false,
      }),
    ).toHaveCount(0);
  }
  for (const dossierId of dossierIds) {
    await foreignPage.goto(`${app}/client-dossiers/${dossierId}`);
    await expect(foreignPage.getByText("Bozza dossier non trovata", { exact: true })).toBeVisible();
    const dossier = await db.clientDossier.findUniqueOrThrow({ where: { id: dossierId } });
    expect((await foreignPage.request.get(`${app}/client-dossiers/${dossierId}/export?versionId=${dossier.approvedVersionId}`)).status()).toBe(404);
  }
  await foreign.close();

  const reader = await browser.newContext();
  const readerPage = await reader.newPage();
  await login(readerPage, "readiness-reader@invalid.test");
  const before = await readinessFootprint();
  const action = capturedStart!;
  const denied = await readerPage.request.fetch(action.url, {
    method: "POST",
    headers: {
      "next-action": action.nextAction,
      "content-type": action.contentType,
      origin: app,
      referer: `${app}/practice-readiness`,
    },
    data: action.body,
    maxRedirects: 0,
  });
  await expectDenied(denied);
  expect(await readinessFootprint()).toEqual(before);

  await page.screenshot({
    path: join(evidenceDir, "practice-readiness-complete.png"),
    fullPage: true,
  });
  writeFileSync(
    join(evidenceDir, "receipt.json"),
    JSON.stringify({
      phase: "complete",
      synthetic: true,
      cases: cases.map((item) => item.key),
      directPostDenied: true,
      reviewRegressions: { indexSensitiveAndArchived: true, nonCanonicalSession: true, approvedDocxXmlOnly: true, browserTimeZone: "Europe/Rome", serverTimeZone: process.env.TZ, deliveryInstant: "2026-09-20T10:00:00.000Z", deliveryReplayIdempotent: true },
    }) + "\n",
    { mode: 0o600 },
  );
  await reader.close();
  await context.close();
});
