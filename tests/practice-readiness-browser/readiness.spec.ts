import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
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

test.beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  await assertSyntheticCatalogDatabase(db);
});
test.afterAll(() => db.$disconnect());
test.afterEach(async ({}, info) => {
  writeFileSync(
    join(evidenceDir, `browser-${info.status}.json`),
    JSON.stringify({
      phase: "browser",
      status: info.status,
      expectedStatus: info.expectedStatus,
      synthetic: true,
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
    await open
      .getByRole("button", { name: "Crea revisione preventivo" })
      .click();
    await expect(page).toHaveURL(/\/practice-readiness\?updated=/u);

    const proposal = await db.practiceOfferRevision.findFirstOrThrow({
      where: { commercialOfferId: `readiness-browser-offer-${item.key}` },
      orderBy: { revision: "desc" },
    });
    const proposalCard = page
      .getByText(scope, { exact: false })
      .locator("xpath=ancestor::article[1]");
    await proposalCard
      .getByRole("button", { name: "Accetta questa revisione" })
      .click();
    const practice = await db.practiceReadiness.findUniqueOrThrow({
      where: { controlledIntakeId: proposal.controlledIntakeId },
    });

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
    await article
      .getByRole("button", { name: "Conferma incarico formalizzato" })
      .click();

    article = await reloadPractice(page, practice.id);
    await article
      .locator('[name="clientServiceId"]')
      .selectOption(`readiness-browser-service-${item.key}`);
    await article
      .getByRole("button", { name: "Collega pratica operativa in attesa" })
      .click();
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
      await article.getByRole("button", { name: "Dichiara accredito" }).click();
      article = await reloadPractice(page, practice.id);
      const funding = article
        .getByText(reference, { exact: false })
        .locator("xpath=ancestor::div[1]");
      await funding.getByRole("button", { name: "Conferma accredito" }).click();
      if (item.partial && part === "prima") {
        article = await reloadPractice(page, practice.id);
        await article
          .getByRole("button", { name: "Avvia esplicitamente" })
          .click();
        await expect(page.getByRole("alert")).toContainText("NOT_READY");
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
        await staleArticle
          .getByRole("button", { name: "Dichiara accredito" })
          .click();
        await expect(stalePage.getByRole("alert")).toContainText("CONFLICT");
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
    await article
      .locator("form")
      .filter({
        has: article.getByRole("button", {
          name: "Registra decisione materiale",
        }),
      })
      .locator('[name="documentId"]')
      .selectOption(`readiness-browser-document-${item.key}`);
    await article
      .locator("form")
      .filter({
        has: article.getByRole("button", {
          name: "Registra decisione materiale",
        }),
      })
      .locator('[name="documentVersionId"]')
      .selectOption(documentVersion.id);
    await article.locator('[name="status"]').selectOption("VALIDATED");
    await article
      .getByRole("button", { name: "Registra decisione materiale" })
      .click();
    article = await reloadPractice(page, practice.id);
    await article
      .getByRole("button", { name: "Attesta materiali completi" })
      .click();

    if (item.key === "standard") {
      article = await reloadPractice(page, practice.id);
      await article
        .locator('[name="checklistItemId"]')
        .selectOption(`readiness-browser-checklist-${item.key}`);
      await article.locator('[name="status"]').selectOption("INVALIDATED");
      await article
        .locator('[name="reason"]')
        .fill("Versione sostituita durante la verifica browser");
      await article
        .getByRole("button", { name: "Registra decisione materiale" })
        .click();
      article = await reloadPractice(page, practice.id);
      await article
        .getByRole("button", { name: "Avvia esplicitamente" })
        .click();
      await expect(page.getByRole("alert")).toContainText("NOT_READY");
      article = await reloadPractice(page, practice.id);
      await article
        .locator('[name="checklistItemId"]')
        .selectOption(`readiness-browser-checklist-${item.key}`);
      const materialForm = article
        .locator("form")
        .filter({
          has: article.getByRole("button", {
            name: "Registra decisione materiale",
          }),
        });
      await materialForm
        .locator('[name="documentId"]')
        .selectOption(`readiness-browser-document-${item.key}`);
      await materialForm
        .locator('[name="documentVersionId"]')
        .selectOption(documentVersion.id);
      await materialForm.locator('[name="status"]').selectOption("VALIDATED");
      await article
        .getByRole("button", { name: "Registra decisione materiale" })
        .click();
      article = await reloadPractice(page, practice.id);
      await article
        .getByRole("button", { name: "Attesta materiali completi" })
        .click();
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
    await article.getByRole("button", { name: "Avvia esplicitamente" }).click();
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
  }

  expect(capturedStart).not.toBeNull();
  const reader = await browser.newContext();
  const readerPage = await reader.newPage();
  await login(readerPage, "readiness-reader@invalid.test");
  const before = await db.auditLog.count({
    where: { event: "practice_started" },
  });
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
  expect(
    await db.auditLog.count({ where: { event: "practice_started" } }),
  ).toBe(before);

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
