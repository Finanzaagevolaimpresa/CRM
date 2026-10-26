import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type BrowserContext } from '@playwright/test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { createInternalSession } from '../../src/lib/internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../../src/lib/session';

const db = new PrismaClient(), evidence = process.env.COMMERCIAL_PROGRESS_EVIDENCE!;
const actors: Record<string, { id: string; role: RoleCode }> = {};
const fixtures: Record<string, { clientId: string; projectId: string; practiceId: string; leadId: string; name: string }> = {};
test.beforeAll(async () => {
  assert.equal(process.env.COMMERCIAL_PROGRESS_BROWSER_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.ok(evidence); mkdirSync(evidence, { recursive: true });
  for (const [key, role] of [['sales_a', 'commerciale'], ['sales_b', 'commerciale'], ['tech_a', 'consulente'], ['tech_b', 'backoffice']] as const) {
    actors[key] = await db.user.create({ data: { name: `Synthetic ${key}`, email: `progress-${key}-${randomUUID()}@example.test`, passwordHash: 'synthetic-no-login-password', role } });
  }
  for (const side of ['a', 'b']) {
    const name = side === 'a' ? 'Cliente sintetico Alfa' : 'Cliente sintetico Beta';
    const client = await db.client.create({ data: { type: 'societa', displayName: name, salesOwnerId: actors[`sales_${side}`].id, consultantId: actors[`tech_${side}`].id } });
    const project = await db.project.create({ data: { clientId: client.id, title: `PRIVATE_PROJECT_TITLE_${side}`, consultantId: actors[`tech_${side}`].id } });
    const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id, title: `PRIVATE_PRACTICE_TITLE_${side}`, practiceType: 'synthetic', targetEntity: 'PRIVATE_ENTITY', internalNotes: 'PRIVATE_TECH_NOTE', clientVisibleStatus: 'UNAPPROVED_FREE_TEXT', commercialOwnerId: actors[`sales_${side}`].id, technicalOwnerId: actors[`tech_${side}`].id, createdById: actors.tech_a.id, status: 'in_progettazione', dueDate: new Date('2026-11-02T09:00:00Z'), nextClientUpdateAt: new Date('2026-10-30T09:00:00Z') } });
    const lead = await db.lead.create({ data: { firstName: 'Lead sintetico', lastName: side === 'a' ? 'Alfa' : 'Beta', assignedToId: actors[`sales_${side}`].id, status: 'da_contattare' } });
    fixtures[side] = { clientId: client.id, projectId: project.id, practiceId: practice.id, leadId: lead.id, name };
  }
});
test.afterAll(async () => { await db.$disconnect(); });
async function admit(context: BrowserContext, key: string) {
  const token = createRegistrySessionToken(), tokenDigest = await digestRegistrySessionToken(token.bytes);
  const registry = await db.$transaction(tx => createInternalSession(tx, { userId: actors[key].id, tokenDigest }));
  await context.addCookies([{ name: 'fai_progress_session', value: token.token, url: 'http://127.0.0.1:3048', httpOnly: true, sameSite: 'Lax' }]);
  return registry;
}
for (const viewport of [{ name: 'desktop', width: 1365, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`${viewport.name}: two sales see own technical progress, search and API only; change of technician preserves access`, async ({ browser }) => {
    for (const side of ['a', 'b']) {
      const context = await browser.newContext({ viewport, baseURL: 'http://127.0.0.1:3048' }), page = await context.newPage();
      await admit(context, `sales_${side}`);
      await page.goto('/progress');
      await expect(page.getByRole('heading', { name: 'Stato e prossime azioni', exact: true })).toBeVisible();
      const section = page.getByRole('region', { name: 'Avanzamento tecnico dei miei clienti' });
      await expect(section.getByText(fixtures[side].name, { exact: true })).toBeVisible();
      await expect(section.getByText('Stato della pratica: In lavorazione', { exact: true })).toBeVisible();
      await expect(section.locator('[data-commercial-progress]')).toHaveCount(1);
      expect(await page.locator('main').innerText()).not.toContain(fixtures[side === 'a' ? 'b' : 'a'].name);
      for (const forbidden of ['PRIVATE_PROJECT_TITLE', 'PRIVATE_PRACTICE_TITLE', 'PRIVATE_ENTITY', 'PRIVATE_TECH_NOTE', 'UNAPPROVED_FREE_TEXT']) expect(await page.locator('main').innerText()).not.toContain(forbidden);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (side === 'a') await page.screenshot({ path: join(evidence, `sales-progress-${viewport.name}.png`), fullPage: true });
      const response = await context.request.get('/api/commercial-progress');
      expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toContain('no-store');
      const value = await response.json(); expect(value.items).toHaveLength(1); expect(value.items[0].id).toBe(fixtures[side].practiceId);
      expect(Object.keys(value.items[0]).sort()).toEqual(['id', 'clientId', 'clientName', 'status', 'statusLabel', 'dueDate', 'nextClientUpdateAt', 'updatedAt'].sort());
      const other = fixtures[side === 'a' ? 'b' : 'a'];
      expect((await (await context.request.get(`/api/commercial-progress?client=${other.clientId}`)).json()).items).toEqual([]);
      await page.getByRole('textbox', { name: 'Cerca cliente' }).fill(other.name);
      await page.getByRole('button', { name: 'Cerca', exact: true }).click();
      await expect(section.locator('[data-commercial-progress]')).toHaveCount(0);
      await db.technicalPractice.update({ where: { id: fixtures[side].practiceId }, data: { technicalOwnerId: actors[side === 'a' ? 'tech_b' : 'tech_a'].id } });
      await page.goto('/progress'); await expect(section.locator('[data-commercial-progress]')).toHaveCount(1);
      await context.close();
    }
  });
}
test('registry revocation, sales reassignment and both technical accounts cannot reuse the sales endpoint', async ({ browser }) => {
  for (const key of ['tech_a', 'tech_b']) {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3048' }); await admit(context, key);
    expect((await context.request.get('/api/commercial-progress')).status()).toBe(403); await context.close();
  }
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3048' }), registry = await admit(context, 'sales_a');
  expect((await (await context.request.get('/api/commercial-progress')).json()).items).toHaveLength(1);
  await db.client.update({ where: { id: fixtures.a.clientId }, data: { salesOwnerId: actors.sales_b.id } });
  expect((await (await context.request.get('/api/commercial-progress')).json()).items).toEqual([]);
  await db.client.update({ where: { id: fixtures.a.clientId }, data: { salesOwnerId: actors.sales_a.id } });
  expect((await (await context.request.get('/api/commercial-progress')).json()).items).toHaveLength(1);
  await db.internalSession.update({ where: { id: registry.id }, data: { revokedAt: new Date(), revokedReason: 'INTERNAL_SINGLE' } });
  expect((await context.request.get('/api/commercial-progress')).status()).toBe(401);
  await context.close();
  writeFileSync(join(evidence, 'projection-proof.json'), JSON.stringify({ synthetic: true, salesAccounts: 2, technicalAccounts: 2, currentSessionRevocation: true, currentSalesReference: true, noFinancialPayload: true, productionContact: false }));
});

for (const viewport of [{ name: 'desktop', width: 1365, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`${viewport.name}: essential role navigation, positive own dashboard counts and current personal restrictions`, async ({ browser }) => {
    test.setTimeout(300_000);
    // The preceding projection test deliberately changes technicians. Restore
    // only these isolated assignments before testing the operational views.
    for (const side of ['a', 'b']) await db.technicalPractice.update({ where: { id: fixtures[side].practiceId }, data: { technicalOwnerId: actors[`tech_${side}`].id } });
    const observations: object[] = [];
    for (const key of ['sales_a', 'sales_b', 'tech_a', 'tech_b']) {
      const side = key.endsWith('_a') ? 'a' : 'b', other = side === 'a' ? 'b' : 'a', sales = key.startsWith('sales_');
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce', baseURL: 'http://127.0.0.1:3048' }), page = await context.newPage();
      const registry = await admit(context, key);
      const openNavigation = async () => {
        if (viewport.name === 'mobile') await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
        const nav = page.locator('nav[aria-label="Navigazione principale"]:visible');
        await expect(nav).toBeVisible();
        return nav;
      };
      try {
        if (!sales) {
          // Mirror the relevant saved restrictions observed on the two technical
          // roles, using only these disposable actors and no real account data.
          for (const permission of ['client.read', 'client.write', 'company.read', 'company.write', 'lead.read', 'lead.write', 'service.read', 'service.write', 'service.assign', 'project.write']) {
            await db.userPermissionOverride.create({ data: { userId: actors[key].id, permission, allowed: false } });
          }
        }
        await page.goto('/dashboard');
        await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
        const main = page.locator('main');
        for (const id of ['amministrazione', 'revisioni-autorizzazioni', sales ? 'ufficio-tecnico' : 'commerciale']) {
          await expect(main.locator(`section[aria-labelledby="counter-area-${id}"]`)).toHaveCount(0);
        }
        await expect(main.locator('#pipeline-pratiche')).toHaveCount(0);
        await expect(main.getByText('Dettaglio operativo completo', { exact: false })).toHaveCount(0);
        const clientProject = main.locator('section[aria-labelledby="counter-area-clienti-servizi"]');
        const positiveLabel = sales ? 'Clienti attivi' : 'Progetti attivi';
        await expect(clientProject.getByRole('link', { name: new RegExp(positiveLabel) }).locator('[data-counter-final]')).toHaveAttribute('data-counter-final', '1');
        await expect(clientProject.getByRole('link', { name: /Servizi acquistati/ })).toHaveCount(0);
        const ownGroup = main.locator(`section[aria-labelledby="counter-area-${sales ? 'commerciale' : 'ufficio-tecnico'}"]`);
        await expect(ownGroup.getByRole('link', { name: new RegExp(sales ? 'Lead da contattare' : 'Pratiche tecniche attive') }).locator('[data-counter-final]')).toHaveAttribute('data-counter-final', '1');
        const detailPath = sales ? `/leads/${fixtures[side].leadId}` : `/technical-office/practices/${fixtures[side].practiceId}`;
        const foreignPath = sales ? `/leads/${fixtures[other].leadId}` : `/technical-office/practices/${fixtures[other].practiceId}`;
        await expect(main.locator(`#dashboard-detail a[href="${detailPath}"]`)).toBeVisible();
        await expect(main.locator(`a[href="${foreignPath}"]`)).toHaveCount(0);
        for (const path of ['/contracts', '/payments', '/dossiers', '/preanalyses', '/ai']) await expect(main.locator(`a[href="${path}"]`)).toHaveCount(0);
        const nav = await openNavigation();
        const allowed = sales ? ['/leads', '/commercial-offers', '/clients', '/progress'] : ['/projects', '/technical-office', '/technical-office/practices', '/technical-office/integrations', '/documents'];
        const forbidden = ['/contracts', '/payments', '/dossiers', '/ai', '/settings/users', '/technical-office/portals', '/technical-office/reporting', ...(sales ? ['/projects', '/technical-office', '/technical-office/integrations', '/documents'] : ['/leads', '/commercial-offers', '/clients', '/progress'])];
        for (const path of allowed) await expect(nav.locator(`a[href="${path}"]`)).toHaveCount(1);
        for (const path of forbidden) await expect(nav.locator(`a[href="${path}"]`)).toHaveCount(0);
        if (side === 'a') await page.screenshot({ path: join(evidence, `${sales ? 'sales' : 'technical'}-navigation-${viewport.name}.png`), fullPage: true });
        if (viewport.name === 'mobile') await page.getByRole('button', { name: 'Chiudi menu', exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        if (side === 'a') await page.screenshot({ path: join(evidence, `${sales ? 'sales' : 'technical'}-dashboard-${viewport.name}.png`), fullPage: true });

        const deniedPermissions = sales ? ['lead.read', 'client.read'] : ['technical.read', 'project.read'];
        for (const permission of deniedPermissions) await db.userPermissionOverride.create({ data: { userId: actors[key].id, permission, allowed: false } });
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
        await expect(ownGroup).toHaveCount(0);
        await expect(clientProject).toHaveCount(0);
        await expect(main.locator(`a[href="${detailPath}"]`)).toHaveCount(0);
        const restrictedNav = await openNavigation();
        for (const path of allowed.filter(path => path !== '/documents')) await expect(restrictedNav.locator(`a[href="${path}"]`)).toHaveCount(0);
        if (sales) expect((await context.request.get('/api/commercial-progress')).status()).toBe(403);
        expect((await db.internalSession.findUniqueOrThrow({ where: { id: registry.id } })).revokedAt).toBeNull();
        observations.push({ actor: key, role: actors[key].role, positiveOwnCount: 1, foreignDetailAbsent: true, currentPermissionDenialWithoutRelogin: true, technicalParentListRestrictions: !sales });
      } finally {
        await db.userPermissionOverride.deleteMany({ where: { userId: actors[key].id } });
        await context.close();
      }
    }
    writeFileSync(join(evidence, `essential-views-${viewport.name}.json`), JSON.stringify({ synthetic: true, presentationScope: true, productionContact: false, observations }, null, 2));
  });
}
