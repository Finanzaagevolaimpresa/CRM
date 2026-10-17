import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { syntheticSession } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { confirmSelectiveAccess, previewSelectiveAccess } from '../../src/lib/selective-project-access';

const db = new PrismaClient(), evidence = process.env.SELECTIVE_EVIDENCE!, password = process.env.SELECTIVE_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; projectId: string; otherProjectId: string; clientId: string; recipientId: string; adminId: string;
  contractId: string; serviceId: string; offerId: string; leadId: string; otherPracticeId: string; otherDocumentId: string;
  emails: { admin: string; recipient: string }; documents: { id: string; versionId: string }[];
};
async function login(page: Page, email: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function action(page: Page, label: string) {
  await page.locator('summary').filter({ hasText: label }).click();
  const form = page.getByRole('form', { name: label, exact: true });
  await expect(form.getByText('Confermo queste conseguenze', { exact: false })).toBeVisible();
  await form.getByLabel('Confermo queste conseguenze').check();
  await form.getByRole('button', { name: label, exact: true }).click();
}
test.afterAll(async () => db.$disconnect());

test('real lifecycle UI, old sessions, indirect exports/downloads and replay preserve the selective perimeter', async ({ browser }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(f.synthetic).toBe(true);
  const ac = await browser.newContext(), rc = await browser.newContext();
  const admin = await ac.newPage(), recipient = await rc.newPage();
  await login(admin, f.emails.admin); await login(recipient, f.emails.recipient);
  const user = await db.user.findUniqueOrThrow({ where: { id: f.adminId } }), authority = await syntheticSession(db, user);
  const input = { projectId: f.projectId, recipientId: f.recipientId, revision: 0, fields: ['title'],
    documents: f.documents.slice(0, 2).map((d, i) => ({ versionId: d.versionId, download: i === 1 })), expiresAt: null };
  const grant = await confirmSelectiveAccess(db, authority.session, (await previewSelectiveAccess(db, authority.session, input)).token, true);
  const grantBefore = await db.selectiveProjectGrant.findUniqueOrThrow({ where: { id: grant.id } });
  const docBefore = await db.documentVersion.findMany({ where: { documentId: { in: f.documents.map(d => d.id) } }, orderBy: { id: 'asc' } });
  const shared = `/shared-projects/${f.projectId}`;
  await recipient.goto(shared); await expect(recipient.getByRole('region', { name: 'Progetto condiviso' })).toContainText('Documento sintetico 2');
  await admin.goto(`/projects/${f.projectId}`);
  await expect(admin.getByRole('heading', { name: 'Gestisci progetto', exact: true })).toBeVisible();
  let captured: { url: string; body: string; headers: Record<string, string> } | undefined;
  admin.on('request', request => {
    if (request.method() === 'POST' && request.headers()['next-action'] && !captured) {
      captured = { url: request.url(), body: request.postData()!, headers: {
        'next-action': request.headers()['next-action'], 'content-type': request.headers()['content-type'], origin: 'http://127.0.0.1:3035',
      } };
    }
  });
  await action(admin, 'Archivia'); await expect(admin).toHaveURL(/\/projects\?view=archive$/);
  await expect(admin.getByRole('heading', { name: 'Progetto sintetico selettivo', exact: true })).toBeVisible();
  await admin.screenshot({ path: path.join(evidence, 'lifecycle-archive.png'), fullPage: true });
  async function deniedRoutes() {
    for (const context of [ac, rc]) {
      expect((await context.request.get(`/projects/${f.projectId}`)).status()).toBe(404);
      for (const doc of f.documents) {
        const response = await context.request.get(`/documents/${doc.id}/download?versionId=${doc.versionId}`, { headers: { 'If-None-Match': '*' } });
        expect(response.status()).toBe(403); expect(response.headers()['cache-control']).toContain('no-store');
      }
      for (const url of ['/projects', `/clients/${f.clientId}`, '/search?q=ESCLUS', '/audit-log', '/contracts', '/payments', '/progress', '/dashboard',
        '/notifications', '/tasks', '/documents', '/commercial-offers', `/leads/${f.leadId}`, `/clients/${f.clientId}/operational-report`]) {
        const response = await context.request.get(url); expect(response.status()).toBeLessThan(500);
        const html = await response.text();
        for (const marker of ['DESCRIZIONE_ESCLUSA_SINTETICA', 'NOTA_PRIVATA_ESCLUSA_SINTETICA', 'Documento sintetico 3', 'COMPENSO_FAI_ESCLUSO',
          'PAGAMENTO_ESCLUSO', 'TASK_PROGETTO_ESCLUSO', 'NOTA_SERVIZIO_ESCLUSA', 'OFFERTA_FAI_ESCLUSA']) expect(html).not.toContain(marker);
      }
      expect((await context.request.get(`/commercial-offers/${f.offerId}/export/docx`)).status()).toBe(404);
      expect((await context.request.get(`/projects/${f.otherProjectId}`)).status()).toBe(200);
      expect((await context.request.get(`/technical-office/practices/${f.otherPracticeId}`)).status()).toBe(200);
      expect(await (await context.request.get(`/documents/${f.otherDocumentId}/download`)).text()).toBe('DOCUMENTO_B_CONTRATTO_COMUNE');
    }
    expect((await rc.request.get(shared)).status()).toBe(404);
    expect((await rc.request.get(`${shared}/documents/${f.documents[1].versionId}?download=1`)).status()).toBe(404);
    expect(await (await rc.request.get('/projects?view=archive')).text()).not.toContain('Progetto sintetico selettivo');
  }
  await deniedRoutes();
  await action(admin, 'Sposta nel cestino'); await expect(admin).toHaveURL(/view=trash$/);
  await admin.screenshot({ path: path.join(evidence, 'lifecycle-trash.png'), fullPage: true });
  await deniedRoutes();
  await action(admin, 'Ripristina in archivio'); await expect(admin).toHaveURL(/view=archive$/);
  await deniedRoutes();
  await action(admin, 'Riattiva come idea'); await expect(admin).toHaveURL(new RegExp(`/projects/${f.projectId}$`));
  expect((await rc.request.get(shared)).status()).toBe(404);
  expect((await ac.request.get(`/documents/${f.documents[0].id}/download`)).status()).toBe(200);
  await admin.goto(`/projects/${f.projectId}/share`);
  await expect(admin.getByText('Sospesa: serve una nuova anteprima e conferma personale', { exact: false })).toBeVisible();
  await admin.screenshot({ path: path.join(evidence, 'lifecycle-restored-sharing.png'), fullPage: true });
  expect(captured).toBeDefined();
  await ac.request.post(captured!.url, { data: captured!.body, headers: captured!.headers });
  await rc.request.post(captured!.url, { data: captured!.body, headers: captured!.headers });
  expect(await db.auditLog.count({ where: { event: 'project_lifecycle_changed', entityId: f.projectId } })).toBe(4);
  expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).status).toBe('idea');
  expect(await db.selectiveProjectGrant.findUniqueOrThrow({ where: { id: grant.id } })).toEqual(grantBefore);
  expect(await db.documentVersion.findMany({ where: { documentId: { in: f.documents.map(d => d.id) } }, orderBy: { id: 'asc' } })).toEqual(docBefore);
  await ac.close(); await rc.close();
});
