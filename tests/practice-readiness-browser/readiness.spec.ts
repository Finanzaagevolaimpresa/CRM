import { mkdirSync, writeFileSync } from "node:fs";
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
  });
  const page = await context.newPage();
  await login(page, "readiness-owner@invalid.test");
  let capturedStart: CapturedAction | null = null;

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
  }

  expect(capturedStart).not.toBeNull();
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
    }) + "\n",
    { mode: 0o600 },
  );
  await reader.close();
  await context.close();
});
