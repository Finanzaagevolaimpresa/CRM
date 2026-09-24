import { test, expect, type Page, type Request } from '@playwright/test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';

const db = new PrismaClient();
const origin = 'http://127.0.0.1:3015';
const password = process.env.M1_BROWSER_PASSWORD!;
const mode = process.env.PRIVILEGED_ACCESS_MODE;
const runId = randomUUID();
const email = (who: string) => `isolation-${who}-${runId}@example.test`;
const roles = ['commerciale', 'consulente', 'backoffice'] satisfies RoleCode[];
type Fixture = { role: typeof roles[number]; ownerId: string; replacementId: string; clientId: string; projectId: string; practiceId: string; offerId: string; taskId: string; checklistId: string; tag: string };
const fixtures: Fixture[] = [];
let adminId: string;
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  expect(['enforced', 'disabled']).toContain(mode);
  expect(password.length).toBeGreaterThanOrEqual(24);
  const passwordHash = await bcrypt.hash(password, 4);
  const admin = await db.user.create({ data: { email: email('admin'), name: 'Isolation admin', role: 'admin', passwordHash } });
  adminId = admin.id;
  for (const role of roles) {
    const owner = await db.user.create({ data: { email: email(role), name: `Isolation ${role}`, role, passwordHash } });
    const replacement = await db.user.create({ data: { email: email(role + '-replacement'), name: `Replacement ${role}`, role, passwordHash } });
    const permissions = ['document.download', 'document.upload', 'document.sensitive.read', 'practice_communications.review'];
    await db.userPermissionOverride.createMany({ data: [owner, replacement].flatMap(user => permissions.map(permission => ({ userId: user.id, permission, allowed: true }))) });
    const tag = `Isolation-${role}-${runId}`;
    const client = await db.client.create({ data: { type: 'societa', displayName: tag + '-client',
      salesOwnerId: role === 'commerciale' ? owner.id : null, consultantId: role === 'commerciale' ? null : owner.id } });
    const project = await db.project.create({ data: { clientId: client.id, title: tag + '-project' } });
    const task = await db.task.create({ data: { clientId: client.id, projectId: project.id, title: tag + '-task',
      dueAt: new Date(Date.now() - 86_400_000), createdById: owner.id } });
    const checklist = await db.documentChecklistItem.create({ data: { clientId: client.id, title: tag + '-checklist', createdById: owner.id, updatedById: owner.id } });
    const offer = await db.commercialOffer.create({ data: { clientId: client.id, title: tag + '-offer',
      taxableAmount: 100, vatAmount: 22, totalAmount: 122, createdById: owner.id, followUpAt: new Date(Date.now() - 86_400_000) } });
    const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id,
      title: tag + '-practice', practiceType: 'Synthetic isolation', targetEntity: 'Synthetic entity', createdById: owner.id } });
    await db.practiceCommunication.create({ data: { technicalPracticeId: practice.id, clientId: client.id, projectId: project.id,
      title: tag + '-communication', content: 'Synthetic communication', type: 'interna', channel: 'nota_interna',
      status: 'da_revisionare', createdById: owner.id, commercialOwnerId: owner.id, technicalOwnerId: owner.id } });
    fixtures.push({ role, ownerId: owner.id, replacementId: replacement.id, clientId: client.id, projectId: project.id,
      practiceId: practice.id, offerId: offer.id, taskId: task.id, checklistId: checklist.id, tag });
  }
  if (mode === 'enforced') await db.applicationKeyVersion.upsert({ where: { purpose_version: { purpose: 'PRIVILEGED_STEP_UP', version: 1 } },
    create: { purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(),
      keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!) }, update: {} });
});
test.afterAll(async () => { await db.$disconnect(); });
async function login(page: Page, who: string) {
  await page.goto('/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email(who));
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}
async function deniedSurfaces(page: Page, f: Fixture, documentId: string) {
  const urls = ['/clients/' + f.clientId, '/projects/' + f.projectId, '/technical-office/practices/' + f.practiceId,
    '/commercial-offers/' + f.offerId, '/documents', '/tasks', '/notifications', '/dashboard', '/search?q=' + encodeURIComponent(f.tag)];
  for (const url of urls) {
    await page.goto(url);
    for (const suffix of ['client', 'project', 'task', 'checklist', 'document', 'practice', 'offer', 'communication']) {
      await expect(page.getByText(f.tag + '-' + suffix, { exact: true })).toHaveCount(0);
    }
  }
  for (const url of ['/documents/' + documentId + '/download', '/clients/' + f.clientId + '/operational-report',
    '/clients/' + f.clientId + '/operational-report/docx', '/technical-office/practices/' + f.practiceId + '/operational-report',
    '/technical-office/practices/' + f.practiceId + '/operational-report/docx']) {
    const response = await page.request.get(url);
    expect(response.status(), url).toBe(403);
    expect(await response.text()).not.toContain(f.tag);
  }
}
async function replayUpload(page: Page, request: Request, fromId: string, toId: string) {
  const data = request.postData()!;
  expect(data).toContain(fromId);
  return page.request.post(request.url(), { headers: {
    'next-action': request.headers()['next-action'], 'content-type': request.headers()['content-type'], origin,
  }, data: data.replaceAll(fromId, toId) });
}

for (const role of roles) test(`${role}: foreign HTTP access is denied; enforced reassignment revokes old uploader in an open session`, async ({ browser }) => {
  test.setTimeout(300_000);
  const f = fixtures.find(row => row.role === role)!;
  const foreign = fixtures.find(row => row.role !== role)!;
  const ownerContext = await browser.newContext({ baseURL: origin }), replacementContext = await browser.newContext({ baseURL: origin });
  const owner = await ownerContext.newPage(), replacement = await replacementContext.newPage();
  await login(owner, role); await login(replacement, role + '-replacement');
  await owner.goto('/clients/' + f.clientId);
  await expect(owner.getByText(f.tag + '-client', { exact: true }).first()).toBeVisible();
  await owner.goto('/notifications');
  for (const suffix of ['task', 'practice', 'offer', 'communication']) await expect(owner.getByRole('heading', { name: f.tag + '-' + suffix, exact: true })).toBeVisible();
  await owner.goto('/documents');
  const upload = owner.locator('form').filter({ has: owner.locator('input[type="file"]') });
  await upload.locator('select[name="clientId"]').selectOption(f.clientId);
  await upload.locator('input[name="title"]').fill(f.tag + '-document');
  const bytes = Buffer.from('Synthetic private document for ' + f.tag, 'utf8');
  await upload.locator('input[type="file"]').setInputFiles({ name: 'isolation.txt', mimeType: 'text/plain', buffer: bytes });
  await upload.getByRole('checkbox').check();
  const pending = owner.waitForRequest(request => Boolean(request.headers()['next-action']) && (request.postData()?.includes(f.tag + '-document') ?? false));
  await upload.getByRole('button', { name: 'Carica in storage privato' }).click();
  const captured = await pending;
  await expect.poll(() => db.document.count({ where: { clientId: f.clientId, title: f.tag + '-document' } })).toBe(1);
  const document = await db.document.findFirstOrThrow({ where: { clientId: f.clientId, title: f.tag + '-document' } });
  expect(document.uploadedById).toBe(f.ownerId);
  const positive = await owner.request.get('/documents/' + document.id + '/download');
  expect(positive.status()).toBe(200); expect(await positive.body()).toEqual(bytes);
  const positiveReport = await owner.request.get('/clients/' + f.clientId + '/operational-report');
  expect(positiveReport.status()).toBe(200); expect(await positiveReport.text()).toContain(f.tag + '-client');
  await deniedSurfaces(replacement, f, document.id);
  const before = await db.document.count();
  await replayUpload(owner, captured, f.clientId, foreign.clientId);
  expect(await db.document.count()).toBe(before);
  if (mode === 'disabled') {
    await ownerContext.close(); await replacementContext.close(); return;
  }

  const adminContext = await browser.newContext({ baseURL: origin }), admin = await adminContext.newPage();
  await login(admin, 'admin');
  await admin.goto('/settings/security');
  await admin.getByLabel('Password corrente').fill(password);
  await admin.getByRole('button', { name: 'Conferma per cinque minuti' }).click();
  await expect(admin).toHaveURL(/status=active/);
  await admin.goto('/clients/' + f.clientId);
  const assignment = admin.getByRole('form', { name: 'Assegna responsabili' });
  await assignment.getByLabel(role === 'commerciale' ? 'Responsabile commerciale' : 'Responsabile tecnico').selectOption(f.replacementId);
  await assignment.getByRole('button', { name: 'Salva responsabili' }).click();
  await expect(assignment.getByRole('status')).toHaveText('Responsabili aggiornati.');
  await deniedSurfaces(owner, f, document.id);
  await replayUpload(owner, captured, f.clientId, f.clientId);
  expect(await db.document.count()).toBe(before);
  await replacement.goto('/clients/' + f.clientId);
  await expect(replacement.getByText(f.tag + '-client', { exact: true }).first()).toBeVisible();
  const next = await replacement.request.get('/documents/' + document.id + '/download');
  expect(next.status()).toBe(200); expect(await next.body()).toEqual(bytes);
  expect((await db.document.findUniqueOrThrow({ where: { id: document.id } })).uploadedById).toBe(f.ownerId);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).createdById).toBe(f.ownerId);
  expect((await db.documentChecklistItem.findUniqueOrThrow({ where: { id: f.checklistId } })).updatedById).toBe(f.ownerId);
  expect((await db.commercialOffer.findUniqueOrThrow({ where: { id: f.offerId } })).createdById).toBe(f.ownerId);
  expect(await db.auditLog.count({ where: { entityId: f.clientId, event: 'client_owners_assigned', actorId: adminId } })).toBe(1);
  await adminContext.close(); await ownerContext.close(); await replacementContext.close();
});
