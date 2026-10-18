import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { playableWebm } from './synthetic-video';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), evidence = process.env.VIDEOS_EVIDENCE!, password = process.env.VIDEOS_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; readerId: string; otherId: string; readerName: string; otherName: string;
  emails: { admin: string; reader: string; other: string };
};
async function login(page: Page, email: string, stepUp = false) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (stepUp) {
    await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Conferma per cinque minuti', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible();
  }
}
async function upload(page: Page) {
  const buffer = await playableWebm(page);
  await page.goto('/videos/manage');
  await page.locator('[data-interactive-ready="true"]').first().waitFor({ state: 'attached' });
  await page.locator('input[type="file"]').setInputFiles({ name: 'training-synthetic.webm', mimeType: 'video/webm', buffer });
  await page.getByRole('button', { name: 'Carica come bozza privata', exact: true }).click();
  const link = page.getByRole('link', { name: 'Apri bozza e scegli i destinatari' }); await expect(link).toBeVisible();
  const id = (await link.getAttribute('href'))!.split('/').at(-1)!; await link.click();
  await expect(page.getByTestId('video-editor')).toHaveAttribute('data-interactive-ready', 'true');
  const title = 'Video sintetico ' + randomUUID();
  await page.getByLabel('Titolo', { exact: true }).fill(title);
  await page.getByLabel('Descrizione', { exact: true }).fill('Istruzioni sintetiche per le persone selezionate');
  await page.getByRole('checkbox', { name: 'Commerciali', exact: true }).check();
  return { id, title, bytes: buffer.length };
}
async function preview(page: Page) {
  await page.getByRole('button', { name: 'Prepara pubblicazione', exact: true }).click();
  await expect(page.getByLabel('Riepilogo video')).toBeVisible();
  await expect(page.getByLabel('Riepilogo video')).toContainText(f.readerName);
  await page.getByRole('checkbox', { name: 'Confermo questa operazione e le persone indicate.' }).check();
}
async function confirm(page: Page) {
  await page.getByRole('button', { name: 'Conferma', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Operazione registrata');
}
async function play(page: Page) {
  const player = page.locator('video');
  await expect(player).toBeVisible();
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2);
  await player.evaluate(async (node: HTMLVideoElement) => { node.muted = true; await node.play(); });
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0.1);
}
async function screenshot(page: Page, name: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true });
}
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(f.synthetic).toBe(true); });
test.afterAll(async () => db.$disconnect());

test('native upload, named area publication, actual playback and protected metadata/GET/HEAD/Range; desktop and mobile', async ({ browser }) => {
  const ac = await browser.newContext(), rc = await browser.newContext(), oc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage(), other = await oc.newPage();
  await login(admin, f.emails.admin, true); await login(reader, f.emails.reader); await login(other, f.emails.other);
  const row = await upload(admin); await preview(admin);
  await screenshot(admin, 'publication-desktop', 1440); await screenshot(admin, 'publication-mobile', 390);
  await confirm(admin);
  await reader.goto('/videos?q=' + encodeURIComponent(row.title)); await expect(reader.getByText(row.title, { exact: true })).toBeVisible();
  await other.goto('/videos?q=' + encodeURIComponent(row.title)); await expect(other.getByText(row.title, { exact: true })).toHaveCount(0);
  await reader.goto('/videos/' + row.id); await play(reader);
  await screenshot(reader, 'playback-desktop', 1440); await screenshot(reader, 'playback-mobile', 390);
  const content = '/videos/' + row.id + '/content';
  const partial = await reader.request.get(content, { headers: { Range: 'bytes=0-15' } });
  expect(partial.status()).toBe(206); expect((await partial.body()).length).toBe(16);
  expect((await reader.request.head(content)).status()).toBe(200);
  expect((await reader.request.get(content + '?download=1')).status()).toBe(404);
  expect((await other.request.get('/videos/' + row.id)).status()).toBe(404);
  for (const method of ['get', 'head'] as const) {
    const denied = await other.request[method](content, { headers: { Range: 'bytes=0-15' } });
    expect(denied.status()).toBe(404); expect(denied.headers()['content-range']).toBeUndefined();
    expect(denied.headers()['content-disposition']).toBeUndefined();
  }
  await admin.goto('/videos/manage/' + row.id + '/preview?as=' + f.readerId); await play(admin);
  await admin.goto('/videos/manage/' + row.id + '/preview?as=' + f.otherId);
  await expect(admin.locator('video')).toHaveCount(0);
  expect(await db.videoRevision.count({ where: { videoId: row.id } })).toBe(2);
  for (const c of [ac, rc, oc]) await c.close();
});

test('an open reader session loses future ranges after revocation; archive and restore cannot revive access', async ({ browser }) => {
  const ac = await browser.newContext(), rc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage();
  await login(admin, f.emails.admin, true); await login(reader, f.emails.reader);
  const row = await upload(admin); await preview(admin); await confirm(admin);
  await reader.goto('/videos/' + row.id); await play(reader);
  await db.userPermissionOverride.create({ data: { userId: f.readerId, permission: 'video.read', allowed: false } });
  expect((await reader.request.get('/videos/' + row.id + '/content', { headers: { Range: 'bytes=16-31' } })).status()).toBe(404);
  await db.userPermissionOverride.deleteMany({ where: { userId: f.readerId, permission: 'video.read' } });
  expect((await reader.request.get('/videos/' + row.id + '/content')).status()).toBe(404);
  await admin.goto('/videos/manage/' + row.id);
  await expect(admin.getByTestId('video-editor')).toHaveAttribute('data-interactive-ready', 'true');
  await admin.getByRole('button', { name: 'Archivia', exact: true }).click();
  await admin.getByRole('checkbox', { name: 'Confermo questa operazione e le persone indicate.' }).check(); await confirm(admin);
  await admin.goto('/videos/manage/' + row.id);
  await expect(admin.getByTestId('video-editor')).toHaveAttribute('data-interactive-ready', 'true');
  await admin.getByRole('button', { name: 'Ripristina in bozza', exact: true }).click();
  await admin.getByRole('checkbox', { name: 'Confermo questa operazione e le persone indicate.' }).check(); await confirm(admin);
  expect((await db.videoEntry.findUniqueOrThrow({ where: { id: row.id } })).state).toBe('DRAFT');
  expect((await reader.request.get('/videos/' + row.id + '/content')).status()).toBe(404);
  expect(await db.videoRevision.count({ where: { videoId: row.id } })).toBe(4);
  for (const c of [ac, rc]) await c.close();
});

test('lost confirmation is reconciled through its receipt; a second click does not create another publication', async ({ browser }) => {
  const ac = await browser.newContext(), admin = await ac.newPage();
  await login(admin, f.emails.admin, true); const row = await upload(admin); await preview(admin);
  let intercepted = false;
  await admin.route('**/videos/manage/' + row.id, async route => {
    if (!intercepted && route.request().method() === 'POST' && route.request().headers()['next-action']) {
      intercepted = true; const response = await route.fetch(); expect(response.ok()).toBe(true);
      await route.abort('failed'); return;
    }
    await route.continue();
  });
  await admin.getByRole('button', { name: 'Conferma', exact: true }).dblclick();
  await expect(admin.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  await admin.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(admin.getByRole('status')).toContainText('Operazione già registrata');
  expect(intercepted).toBe(true);
  expect(await db.videoCommand.count({ where: { videoId: row.id, operation: 'PUBLISH' } })).toBe(1);
  expect(await db.videoRevision.count({ where: { videoId: row.id } })).toBe(2);
  expect(await db.auditLog.count({ where: { entityId: row.id, event: 'VIDEO_LIBRARY_MUTATION' } })).toBe(2);
  await ac.close();
});

for (const reason of ['inactive', 'deleted', 'read-permission-revoked'] as const) {
  for (const restored of [false, true]) {
    test('remove unavailable named recipient: ' + reason + (restored ? ', restored draft' : ', published video'), async ({ browser }) => {
      const ac = await browser.newContext(), rc = await browser.newContext(), oc = await browser.newContext();
      const admin = await ac.newPage(), reader = await rc.newPage(), other = await oc.newPage();
      const original = await db.user.findUniqueOrThrow({ where: { id: f.readerId }, select: { active: true, deletedAt: true } });
      expect(original).toEqual({ active: true, deletedAt: null });
      expect(await db.userPermissionOverride.count({ where: { userId: f.readerId, permission: 'video.read' } })).toBe(0);
      try {
        await login(admin, f.emails.admin, true); await login(reader, f.emails.reader); await login(other, f.emails.other);
        const row = await upload(admin), content = '/videos/' + row.id + '/content';
        await admin.getByRole('checkbox', { name: 'Commerciali', exact: true }).uncheck();
        await admin.getByRole('checkbox', { name: f.readerName + ' (commerciale)', exact: true }).check();
        await preview(admin); await confirm(admin);
        await reader.goto('/videos/' + row.id); await play(reader);
        if (reason === 'inactive') await db.user.update({ where: { id: f.readerId }, data: { active: false } });
        else if (reason === 'deleted') await db.user.update({ where: { id: f.readerId }, data: { deletedAt: new Date() } });
        else await db.userPermissionOverride.create({ data: { userId: f.readerId, permission: 'video.read', allowed: false } });
        expect((await reader.request.get(content, { headers: { Range: 'bytes=16-31' } })).status()).toBe(404);
        async function openEditor() {
          await admin.goto('/videos/manage/' + row.id);
          await expect(admin.getByTestId('video-editor')).toHaveAttribute('data-interactive-ready', 'true');
        }
        if (restored) {
          for (const operation of ['Archivia', 'Ripristina in bozza']) {
            await openEditor();
            await admin.getByRole('button', { name: operation, exact: true }).click();
            await admin.getByRole('checkbox', { name: 'Confermo questa operazione e le persone indicate.' }).check();
            await confirm(admin);
          }
          const draft = await db.videoEntry.findUniqueOrThrow({ where: { id: row.id } });
          expect(draft.state).toBe('DRAFT'); expect(draft.audience).toEqual([]);
          expect(draft.publishedById).toBeNull(); expect(draft.publisherEpoch).toBeNull();
        }
        await openEditor();
        await expect(admin.getByRole('checkbox', { name: f.readerName + ' (commerciale)', exact: true })).toHaveCount(0);
        const unavailable = admin.getByLabel('Destinatari non disponibili', { exact: true });
        await expect(unavailable).toContainText('Destinatari selezionati non più disponibili: 1.');
        await expect(unavailable).not.toContainText(f.readerName);
        const otherChoice = admin.getByRole('checkbox', { name: f.otherName + ' (backoffice)', exact: true });
        await otherChoice.check();
        const before = await db.videoEntry.findUniqueOrThrow({ where: { id: row.id } });
        expect(before.selection).toEqual({ people: [f.readerId], areas: [] });
        // Both mutations still fail closed while the unavailable ID is retained.
        for (const operation of ['Prepara pubblicazione', 'Prepara bozza']) {
          await admin.getByRole('button', { name: operation, exact: true }).click();
          await expect(admin.getByRole('status')).toContainText('Operazione non confermata.');
          await expect(admin.getByLabel('Riepilogo video')).toHaveCount(0);
        }
        if (reason === 'read-permission-revoked' && restored) {
          await screenshot(admin, 'recipient-removal-desktop', 1440);
          await screenshot(admin, 'recipient-removal-mobile', 390);
        }
        await admin.getByRole('button', { name: 'Rimuovi destinatari non disponibili', exact: true }).click();
        await expect(unavailable).toHaveCount(0); await expect(otherChoice).toBeChecked();
        // Removing from the editor alone cannot mutate the stored selection.
        expect((await db.videoEntry.findUniqueOrThrow({ where: { id: row.id } })).selection).toEqual(before.selection);
        await admin.getByRole('button', { name: 'Prepara bozza', exact: true }).click();
        await expect(admin.getByLabel('Riepilogo video')).toBeVisible();
        await admin.getByRole('checkbox', { name: 'Confermo questa operazione e le persone indicate.' }).check();
        await confirm(admin);
        const saved = await db.videoEntry.findUniqueOrThrow({ where: { id: row.id } });
        expect(saved.state).toBe('DRAFT'); expect(saved.audience).toEqual([]);
        expect(saved.selection).toEqual({ people: [f.otherId], areas: [] });
        expect((await other.request.get(content)).status()).toBe(404);
        await openEditor();
        await expect(unavailable).toHaveCount(0); await expect(otherChoice).toBeChecked();
        await admin.getByRole('button', { name: 'Prepara pubblicazione', exact: true }).click();
        const summary = admin.getByLabel('Riepilogo video');
        await expect(summary).toContainText(f.otherName); await expect(summary).not.toContainText(f.readerName);
        await admin.getByRole('checkbox', { name: 'Confermo questa operazione e le persone indicate.' }).check();
        await confirm(admin);
        const published = await db.videoEntry.findUniqueOrThrow({ where: { id: row.id } });
        expect(published.state).toBe('PUBLISHED');
        expect(published.selection).toEqual({ people: [f.otherId], areas: [] });
        expect(published.audience).toEqual([{ id: f.otherId, epoch: expect.any(Number), role: 'backoffice' }]);
        expect((await reader.request.get(content, { headers: { Range: 'bytes=16-31' } })).status()).toBe(404);
        await other.goto('/videos/' + row.id); await play(other);
        expect(await db.videoRevision.count({ where: { videoId: row.id } })).toBe(restored ? 6 : 4);
        expect(await db.videoCommand.count({ where: { videoId: row.id } })).toBe(restored ? 6 : 4);
        expect(await db.auditLog.count({ where: { entityId: row.id, event: 'VIDEO_LIBRARY_MUTATION' } })).toBe(restored ? 6 : 4);
      } finally {
        if (reason === 'read-permission-revoked')
          await db.userPermissionOverride.deleteMany({ where: { userId: f.readerId, permission: 'video.read' } });
        else await db.user.update({ where: { id: f.readerId }, data: original });
        for (const context of [ac, rc, oc]) await context.close();
      }
    });
  }
}
