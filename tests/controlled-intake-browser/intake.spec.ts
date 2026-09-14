import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { ControlledIntakeError, createControlledIntake } from '../../src/lib/controlled-intake';
import { assignCommercialLeadInboxItem } from '../../src/lib/commercial-lead-inbox';
import { assertSyntheticCatalogDatabase } from '../../src/lib/service-catalog-v2-persistence';

const app = 'http://127.0.0.1:3000';
const password = process.env.CONTROLLED_INTAKE_BROWSER_PASSWORD!;
const evidence = process.env.CONTROLLED_INTAKE_BROWSER_EVIDENCE_DIR!;
const db = new PrismaClient();
type CapturedAction = { url: string; nextAction: string; contentType: string; body: string };

function captureNextAction(page: Page) {
  let captured: CapturedAction | null = null;
  page.on('request', (request) => {
    const headers = request.headers();
    if (!captured && request.method() === 'POST' && headers['next-action']) captured = {
      url: request.url(), nextAction: headers['next-action'],
      contentType: headers['content-type'] ?? '', body: request.postData() ?? '',
    };
  });
  return () => captured;
}

async function postCapturedAction(page: Page, action: CapturedAction) {
  return page.request.fetch(action.url, {
    method: 'POST',
    headers: {
      'next-action': action.nextAction,
      'content-type': action.contentType,
      origin: app,
      referer: `${app}/controlled-intakes`,
    },
    data: action.body,
    maxRedirects: 0,
  });
}

function expectDashboardActionDenial(response: APIResponse) {
  expect(response.status()).toBe(200);
  const actionRedirect = response.headers()['x-action-redirect'];
  expect(actionRedirect).toBeTruthy();
  const destination = actionRedirect!.split(';', 1)[0];
  expect(new URL(destination, app).href).toBe(`${app}/dashboard`);
  expect(actionRedirect).not.toContain('created=');
  expect(actionRedirect).not.toContain('#intake-');
}

async function login(page: Page, email: string) {
  await page.goto(`${app}/login`);
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(`${app}/dashboard`);
}

async function record(page: Page, data: {
  channel: string; sourceId: string; subjectType: string; category: string; need: string;
  email?: string; service?: string; digital?: string; objective?: string; functions?: string;
  administrative?: string; engagementReference?: string; commercialOfferId?: string;
}) {
  await page.goto(`${app}/controlled-intakes`);
  const form = page.getByRole('heading', { name: 'Nuova richiesta' }).locator('xpath=ancestor::section[1]');
  await form.locator('[name="channel"]').selectOption(data.channel);
  await form.locator('[name="sourceId"]').fill(data.sourceId);
  await form.locator('[name="sourceOccurredAt"]').fill('2026-09-14T10:00');
  await form.locator('[name="subjectType"]').selectOption(data.subjectType);
  await form.locator('[name="firstName"]').fill('Mario');
  await form.locator('[name="lastName"]').fill('Inventato');
  await form.locator('[name="email"]').fill(data.email ?? 'same@browser.invalid');
  await form.locator('[name="effectiveCategory"]').fill(data.category);
  await form.locator('[name="need"]').fill(data.need);
  if (data.service) await form.locator('[name="serviceCode"]').selectOption(data.service);
  if (data.digital) await form.locator('[name="digitalProjectType"]').selectOption(data.digital);
  if (data.objective) await form.locator('[name="objective"]').fill(data.objective);
  if (data.functions) await form.locator('[name="functions"]').fill(data.functions);
  if (data.administrative) await form.locator('[name="administrativeRequest"]').fill(data.administrative);
  if (data.engagementReference) await form.locator('[name="engagementReference"]').fill(data.engagementReference);
  if (data.commercialOfferId) await form.locator('[name="commercialOfferId"]').fill(data.commercialOfferId);
  await form.getByRole('button', { name: 'Registra richiesta' }).click();
  await expect(page.getByRole('status')).toHaveText('Richiesta registrata. Lo stato di presa in carico è indicato nella scheda.');
  await expect(page.getByText(`ID ${data.sourceId}`, { exact: false })).toBeVisible();
}

test.beforeAll(() => assertSyntheticCatalogDatabase(db));
test.afterAll(() => db.$disconnect());

test('four controlled channels, decisions, current assignment and direct denial', async ({ browser }) => {
  mkdirSync(evidence, { recursive: true });
  const anonymous = await browser.newPage();
  await anonymous.goto(`${app}/controlled-intakes`);
  await expect(anonymous).toHaveURL(`${app}/login`);

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await login(page, 'intake-owner@invalid.test');
  const createdActionCapture = captureNextAction(page);
  await record(page, { channel: 'WPFORMS_1265', sourceId: 'B-1265', subjectType: 'IMPRESA', category: 'da_classificare', need: 'Continuità manuale' });
  await record(page, { channel: 'WPFORMS_1098', sourceId: 'B-1098', subjectType: 'SOGGETTO_DA_COSTITUIRE', service: 'progetti_digitali', digital: 'software_crm_workflow', category: 'digitale', need: 'Brief digitale', objective: 'Workflow', functions: 'Ruoli' });
  await record(page, { channel: 'EMAIL', sourceId: 'B-EMAIL', subjectType: 'PROFESSIONISTA', service: 'consulenza_fiscale', category: 'fiscale', need: 'Richiesta fiscale' });

  const offer = await db.commercialOffer.findFirstOrThrow({ where: { title: 'Preventivo pertinente' } });
  await record(page, { channel: 'WPFORMS_1485', sourceId: 'B-1485', subjectType: 'PERSONA', email: 'admin@intake.invalid', category: 'amministrativa', need: 'Richiesta dati', administrative: 'Bonifico da riconciliare', engagementReference: 'PREV-DICHIARATO', commercialOfferId: offer.id });
  await expect(page.getByText(/Amministrazione: riferimento verificato · dichiarato: PREV-DICHIARATO/u)).toBeVisible();

  const automaticForm = page.getByRole('button', { name: 'Collega e classifica 1265 autenticato' }).first().locator('xpath=ancestor::form[1]');
  const projectionLedgerId = await automaticForm.locator('[name="projectionLedgerId"]').inputValue();
  expect(await db.controlledIntake.count({ where: { sourceProjectionLedgerId: projectionLedgerId } })).toBe(0);
  await automaticForm.locator('[name="subjectType"]').selectOption('SOGGETTO_DA_COSTITUIRE');
  await automaticForm.locator('[name="effectiveCategory"]').fill('digitale');
  await automaticForm.locator('[name="need"]').fill('Classificazione umana');
  await automaticForm.locator('[name="serviceCode"]').selectOption('progetti_digitali');
  await automaticForm.locator('[name="digitalProjectType"]').selectOption('software_crm_workflow');
  const before1265Url = page.url();
  const previousCreatedId = new URL(before1265Url).searchParams.get('created');
  await Promise.all([
    page.waitForURL((url) => {
      const createdId = url.searchParams.get('created');
      return Boolean(
        createdId
        && createdId !== previousCreatedId
        && url.href !== before1265Url
        && url.hash === `#intake-${createdId}`,
      );
    }),
    automaticForm.getByRole('button', { name: 'Collega e classifica 1265 autenticato' }).click(),
  ]);
  const created1265Id = new URL(page.url()).searchParams.get('created');
  expect(created1265Id).toMatch(/^[0-9a-f-]{36}$/u);
  expect(page.url()).toContain(`#intake-${created1265Id}`);
  await expect.poll(async () => db.controlledIntake.findUnique({ where: { sourceProjectionLedgerId: projectionLedgerId } }), {
    message: `Attesa persistenza intake sintetico per ledger ${projectionLedgerId}`,
    timeout: 10_000,
  }).not.toBeNull();
  const linked1265 = await db.controlledIntake.findUniqueOrThrow({ where: { sourceProjectionLedgerId: projectionLedgerId } });
  expect(linked1265.id).toBe(created1265Id);
  expect(linked1265.leadId).toBe((await db.leadProjectionLedger.findUniqueOrThrow({ where: { id: projectionLedgerId } })).leadId);
  expect(linked1265.subjectType).toBe('SOGGETTO_DA_COSTITUIRE');
  expect(linked1265.effectiveCategory).toBe('digitale');
  expect(linked1265.serviceRevisionId).not.toBeNull();
  const linkedCard = page.locator(`#intake-${linked1265.id}`);
  await expect(linkedCard.getByText(/AUTHENTICATED_AUTOMATIC/u)).toBeVisible();
  await expect(linkedCard.getByText(/Classificazione: digitale · software_crm_workflow/u)).toBeVisible();

  const decisionActionCapture = captureNextAction(page);
  const decisionForm = page.getByRole('button', { name: 'Registra decisione' }).first().locator('xpath=ancestor::form[1]');
  const decisionIntakeId = await decisionForm.locator('[name="intakeId"]').inputValue();
  const decisionButton = decisionForm.getByRole('button', { name: 'Registra decisione' });
  await decisionButton.click();
  await expect.poll(() => db.controlledIntakeDuplicateDecision.findUnique({ where: { intakeId: decisionIntakeId } }), {
    message: `Attesa decisione duplicato sintetica per intake ${decisionIntakeId}`,
    timeout: 10_000,
  }).not.toBeNull();
  await expect(page.locator(`#intake-${decisionIntakeId}`).getByText('Decisione duplicato: KEEP_DISTINCT')).toBeVisible();
  const capturedDecision = decisionActionCapture();
  expect(capturedDecision).not.toBeNull();

  const browserIntake = await db.controlledIntake.findUniqueOrThrow({ where: { channel_sourceId: { channel: 'WPFORMS_1098', sourceId: 'B-1098' } } });
  await db.lead.update({ where: { id: browserIntake.leadId }, data: { notes: 'Nota browser indipendente' } });
  const managerPage = await browser.newPage();
  await login(managerPage, 'intake-manager@invalid.test');
  const managerSession = await db.internalSession.findFirstOrThrow({ where: { userId: 'controlled-intake-browser-manager', revokedAt: null }, orderBy: { createdAt: 'desc' } });
  const browserInbox = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId: browserIntake.leadId } });
  await assignCommercialLeadInboxItem(db, {
    leadId: browserIntake.leadId,
    actor: { userId: 'controlled-intake-browser-manager', sessionId: managerSession.id },
    targetUserId: 'controlled-intake-browser-other',
    expectedInboxVersion: browserInbox.version,
  });
  const reassigned = await browser.newPage();
  await login(reassigned, 'intake-other@invalid.test');
  await reassigned.goto(`${app}/controlled-intakes`);
  const reassignedCard = reassigned.locator(`#intake-${browserIntake.id}`);
  await expect(reassignedCard.getByText(/Esigenza: Brief digitale/u)).toBeVisible();
  await expect(reassignedCard.getByText(/Assegnazione corrente: tu/u)).toBeVisible();

  await page.screenshot({ path: join(evidence, 'controlled-intakes-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidence, 'controlled-intakes-mobile.png'), fullPage: true });

  const denied = await browser.newPage();
  await login(denied, 'intake-reader@invalid.test');
  await denied.goto(`${app}/controlled-intakes`);
  await expect(denied.getByRole('heading', { name: 'Nuova richiesta' })).toHaveCount(0);
  await expect(denied.getByRole('button', { name: 'Registra decisione' })).toHaveCount(0);
  const deniedUser = await db.user.findUniqueOrThrow({ where: { email: 'intake-reader@invalid.test' } });
  const deniedSession = await db.internalSession.findFirstOrThrow({ where: { userId: deniedUser.id, revokedAt: null }, orderBy: { createdAt: 'desc' } });
  const before = await db.controlledIntake.count();
  await expect(createControlledIntake(db, {
    userId: deniedUser.id, sessionId: deniedSession.id, expiresAt: Math.floor(deniedSession.expiresAt.getTime() / 1000),
    role: 'revisore', active: true, permissionOverrides: [],
  }, { channel: 'EMAIL', sourceId: 'DIRECT-DENIED', sourceOccurredAt: '2026-09-14T10:00:00.000Z', subjectType: 'PERSONA', firstName: 'No', lastName: 'Accesso', effectiveCategory: 'negata', need: 'Non deve essere registrata', indicativeBudget: null })).rejects.toMatchObject({ code: 'DENIED' } satisfies Partial<ControlledIntakeError>);
  expect(await db.controlledIntake.count()).toBe(before);
  const capturedCreate = createdActionCapture();
  expect(capturedCreate).not.toBeNull();
  const deniedCreateResponse = await postCapturedAction(denied, capturedCreate!);
  expectDashboardActionDenial(deniedCreateResponse);
  expect(await db.controlledIntake.count()).toBe(before);
  const decisionCount = await db.controlledIntakeDuplicateDecision.count();
  const decisionBeforeDenial = await db.controlledIntakeDuplicateDecision.findUniqueOrThrow({ where: { intakeId: decisionIntakeId } });
  const decisionIntakeVersion = (await db.controlledIntake.findUniqueOrThrow({ where: { id: decisionIntakeId } })).version;
  const deniedDecisionResponse = await postCapturedAction(denied, capturedDecision!);
  expectDashboardActionDenial(deniedDecisionResponse);
  expect(await db.controlledIntakeDuplicateDecision.count()).toBe(decisionCount);
  expect(await db.controlledIntakeDuplicateDecision.findUniqueOrThrow({ where: { intakeId: decisionIntakeId } })).toEqual(decisionBeforeDenial);
  expect((await db.controlledIntake.findUniqueOrThrow({ where: { id: decisionIntakeId } })).version).toBe(decisionIntakeVersion);

  writeFileSync(join(evidence, 'controlled-intake-receipt.json'), JSON.stringify({
    synthetic: true, anonymousDenied: true, channels: 4, persisted: true,
    automatic1265Linked: true, administrativeReferenceVerified: true,
    duplicateDecisionRecorded: true, notesIndependent: true, currentAssignmentReloaded: true,
    directServiceDeniedWithoutEffects: true, httpCreateDenied: true,
    httpDecisionDenied: true, desktop: true, mobile390: true,
  }), { mode: 0o600 });
  await anonymous.close();
  await managerPage.close();
  await reassigned.close();
  await context.close();
});
