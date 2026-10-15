import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const evidence = process.env.SELECTIVE_EVIDENCE!, password = process.env.SELECTIVE_BROWSER_PASSWORD!;
const fixture = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; projectId: string; otherProjectId: string; clientId: string; recipientId: string;
  contractId: string; serviceId: string;
  emails: { admin: string; recipient: string; other: string }; documents: { id: string; versionId: string }[];
};
const db = new PrismaClient();
async function login(page: Page, email: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
test.afterAll(async () => db.$disconnect());
test('personal confirmation, exact preview, recipient routes and revocation with open sessions', async ({ browser }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(fixture.synthetic).toBe(true);
  const ac = await browser.newContext(), rc = await browser.newContext(), oc = await browser.newContext();
  const admin = await ac.newPage(), recipient = await rc.newPage(), other = await oc.newPage();
  await login(admin, fixture.emails.admin); await login(recipient, fixture.emails.recipient); await login(other, fixture.emails.other);
  const manage = `/projects/${fixture.projectId}/share`, shared = `/shared-projects/${fixture.projectId}`;
  expect((await oc.request.get(manage)).status()).toBe(404);
  expect((await rc.request.get(manage)).status()).toBe(404);
  await admin.goto('/settings/security'); await admin.getByLabel('Password corrente').fill(password);
  await admin.getByRole('button', { name: 'Conferma per cinque minuti' }).click(); await expect(admin).toHaveURL(/status=active/);
  await admin.goto(manage);
  await admin.getByLabel('Persona esistente').selectOption(fixture.recipientId);
  await admin.getByLabel('Titolo', { exact: true }).check(); await admin.getByLabel('Investimento', { exact: true }).check();
  await admin.getByLabel('Documento sintetico 1 — v1', { exact: false }).check();
  await admin.getByLabel('Documento sintetico 2 — v1', { exact: false }).check();
  const doc2 = admin.locator('fieldset').filter({ has: admin.locator('legend', { hasText: 'Documenti e versioni' }) }).locator('div.rounded').filter({ hasText: 'Documento sintetico 2' });
  await doc2.getByLabel('Consenti scaricamento').check();
  await admin.getByRole('button', { name: 'Anteprima come utente', exact: true }).click();
  const preview = admin.getByRole('region', { name: 'Anteprima come utente' });
  await expect(preview).toBeVisible(); await expect(preview).toContainText('Documento sintetico 1'); await expect(preview).toContainText('Documento sintetico 2');
  await expect(preview).not.toContainText('Documento sintetico 3'); await expect(preview).not.toContainText('ESCLUSA');
  expect(await db.selectiveProjectGrant.count()).toBe(0);
  await admin.screenshot({ path: path.join(evidence, 'preview.png'), fullPage: true });
  await admin.getByLabel('Confermo personalmente la selezione e l’impatto indicati.').check();
  await admin.getByRole('button', { name: 'Conferma accesso', exact: true }).click();
  await expect(admin.getByText('Accesso selettivo confermato.', { exact: false })).toBeVisible();
  await recipient.goto(shared); const view = recipient.getByRole('region', { name: 'Progetto condiviso' });
  await expect(view).toContainText('Progetto sintetico selettivo'); await expect(view).toContainText('180000');
  await expect(view).toContainText('Documento sintetico 1'); await expect(view).toContainText('Documento sintetico 2');
  await expect(view).not.toContainText('Documento sintetico 3'); await expect(view).not.toContainText('ESCLUSA');
  await expect(view.getByRole('link', { name: 'Scarica questa versione' })).toHaveCount(1);
  await recipient.screenshot({ path: path.join(evidence, 'recipient.png'), fullPage: true });
  const documentUrl = (index: number) => `${shared}/documents/${fixture.documents[index].versionId}`;
  const read = await rc.request.get(documentUrl(0)); expect(read.status()).toBe(200); expect(await read.text()).toBe('CONTENUTO_SINTETICO_DOCUMENTO_1');
  expect(read.headers()['cache-control']).toContain('no-store');
  expect((await rc.request.get(documentUrl(0) + '?download=1')).status()).toBe(404);
  expect((await rc.request.get(documentUrl(1) + '?download=1')).status()).toBe(200);
  expect((await rc.request.get(documentUrl(2))).status()).toBe(404);
  for (const doc of fixture.documents) expect((await rc.request.get(`/documents/${doc.id}/download?versionId=${doc.versionId}`)).status()).toBe(403);
  const future = await db.documentVersion.create({ data: { documentId: fixture.documents[0].id, version: 2, storagePath: 'selective/not-served.txt', checksum: createHash('sha256').update('FUTURE').digest('hex') } });
  expect((await rc.request.get(`${shared}/documents/${future.id}`)).status()).toBe(404);
  for (const url of [`/projects/${fixture.projectId}`, `/clients/${fixture.clientId}`, '/search?q=ESCLUS', '/audit-log', `/clients/${fixture.clientId}/operational-report`,
    '/contracts', '/payments', `/contracts/${fixture.contractId}`, '/progress', '/dashboard', '/notifications', '/tasks', '/documents']) {
    const response = await rc.request.get(url), text = await response.text();
    expect(response.status()).toBeLessThan(500); expect(text).not.toContain('NOTA_PRIVATA_ESCLUSA_SINTETICA'); expect(text).not.toContain('DESCRIZIONE_ESCLUSA_SINTETICA');
    expect(text).not.toContain('Documento sintetico 3');
    for (const marker of ['CONTRATTO_ESCLUSO_', 'COMPENSO_FAI_ESCLUSO', 'PAGAMENTO_ESCLUSO', 'MARGINE_PRIVATO_ESCLUSO', 'NOTA_SERVIZIO_ESCLUSA', 'MARGINE_SERVIZIO_ESCLUSO', 'TASK_PROGETTO_ESCLUSO']) expect(text).not.toContain(marker);
  }
  const otherProject = await rc.request.get(`/projects/${fixture.otherProjectId}`); expect(otherProject.status()).toBe(200); expect(await otherProject.text()).toContain('Altro fascicolo invariato');
  await admin.reload(); await admin.getByRole('button', { name: 'Revoca accesso', exact: true }).click();
  await expect(admin.getByText('Accesso revocato.', { exact: false })).toBeVisible();
  const revoked = await db.selectiveProjectGrant.findUniqueOrThrow({ where: { projectId_recipientId: { projectId: fixture.projectId, recipientId: fixture.recipientId } } });
  expect(revoked.revokedAt).not.toBeNull(); expect(revoked.revision).toBe(2);
  expect(await db.auditLog.count({ where: { event: 'selective_project_access_revoked', entityId: revoked.id } })).toBe(1);
  await admin.reload(); await expect(admin.getByText('Accesso revocato.', { exact: false })).toBeVisible();
  expect((await rc.request.get(documentUrl(1) + '?download=1', { headers: { 'If-None-Match': '*' } })).status()).toBe(404);
  expect((await rc.request.get(shared)).status()).toBe(404);
  expect((await rc.request.get(`/projects/${fixture.projectId}`)).status()).toBe(404);
  await recipient.goto(shared); await recipient.screenshot({ path: path.join(evidence, 'revoked.png'), fullPage: true });
  writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ synthetic: true, personalAuthority: true, existingRecipientSession: true, exactFields: 2, exactVersions: 2,
    thirdDocumentDenied: true, futureVersionDenied: true, downloadOptIn: true, legacyUrlsDenied: true, otherProjectUnchanged: true, revokeExistingSessionAndLinks: true, noStore: true }));
  await ac.close(); await rc.close(); await oc.close();
});
