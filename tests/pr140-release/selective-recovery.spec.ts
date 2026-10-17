import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

test('packaged restart retains live selections and revoked perimeters', async ({ page }) => {
  const f = JSON.parse(readFileSync(process.env.R05_SELECTIVE_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; email: string; projectId: string; revokedProjectId: string; clientId: string; contractId: string; versions: string[];
    lifecycleProjectId: string; lifecycleDocumentId: string; lifecycleVersionId: string; archivedProjectId: string; trashProjectId: string;
    trashedLeadId: string; trashedLeadLabel: string; trashedOfferId: string; preservedClientId: string; restoredLeadId: string; restoredLeadLabel: string;
  };
  expect(f.synthetic).toBe(true);
  const app = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!, phase = process.env.R05_SELECTIVE_PHASE!;
  expect(['candidate', 'restart', 'resume']).toContain(phase);
  await page.goto(app + '/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email').fill(f.email); await page.getByLabel('Password').fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(app + '/dashboard');
  await page.goto(`${app}/shared-projects/${f.projectId}`);
  const projection = page.getByRole('region', { name: 'Progetto condiviso' });
  await expect(projection).toContainText('Progetto sintetico selettivo'); await expect(projection).toContainText('180000');
  await expect(projection).toContainText('Documento sintetico 1'); await expect(projection).toContainText('Documento sintetico 2');
  await expect(projection).not.toContainText('ESCLUSA'); await expect(projection).not.toContainText('Documento sintetico 3');
  for (const [index, status] of [[0, 200], [1, 200], [2, 404]]) {
    expect((await page.request.get(`${app}/shared-projects/${f.projectId}/documents/${f.versions[index]}`)).status()).toBe(status);
  }
  expect((await page.request.get(`${app}/shared-projects/${f.revokedProjectId}`)).status()).toBe(404);
  expect((await page.request.get(`${app}/projects/${f.revokedProjectId}`)).status()).toBe(404);
  for (const projectId of [f.lifecycleProjectId, f.archivedProjectId, f.trashProjectId]) {
    expect((await page.request.get(`${app}/projects/${projectId}`)).status()).toBe(404);
    expect((await page.request.get(`${app}/shared-projects/${projectId}`)).status()).toBe(404);
  }
  expect((await page.request.get(`${app}/shared-projects/${f.lifecycleProjectId}/documents/${f.lifecycleVersionId}`)).status()).toBe(404);
  expect((await page.request.get(`${app}/documents/${f.lifecycleDocumentId}/download`)).status()).toBe(403);
  const projects = await (await page.request.get(`${app}/projects`)).text();
  expect(projects).not.toContain('RECOVERY_ARCHIVED_SYNTHETIC'); expect(projects).not.toContain('RECOVERY_TRASH_SYNTHETIC');
  const hiddenLead = await page.request.get(`${app}/leads/${f.trashedLeadId}`);
  expect(await hiddenLead.text()).not.toContain(f.trashedLeadLabel);
  expect((await page.request.get(`${app}/commercial-offers/${f.trashedOfferId}/export/docx`)).status()).toBe(404);
  expect((await page.request.get(`${app}/clients/${f.preservedClientId}`)).status()).toBe(200);
  const restoredLead = await page.request.get(`${app}/leads/${f.restoredLeadId}`);
  expect(restoredLead.status()).toBe(200); expect(await restoredLead.text()).toContain(f.restoredLeadLabel);
  expect(await (await page.request.get(`${app}/leads/trash`)).text()).toContain(f.trashedLeadLabel);
  for (const suffix of [`/clients/${f.clientId}`, `/contracts/${f.contractId}`, '/payments', '/notifications']) {
    const response = await page.request.get(app + suffix); expect(response.status()).toBeLessThan(500);
    const html = await response.text();
    for (const marker of ['COMPENSO_FAI_ESCLUSO', 'PAGAMENTO_ESCLUSO', 'TASK_PROGETTO_ESCLUSO']) expect(html).not.toContain(marker);
  }
  await page.screenshot({ path: path.join(path.dirname(process.env.R05_SELECTIVE_RECOVERY_FIXTURE!), `selective-${phase}.png`), fullPage: true });
});
