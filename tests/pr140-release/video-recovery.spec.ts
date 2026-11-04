import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
test('schema63 restart preserves private video playback, immutable history and revoked/archived audience', async ({ browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_VIDEO_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; noProvider: boolean; readerEmail: string; otherEmail: string; revokedEmail: string;
    records: Record<'PUBLISHED' | 'ARCHIVED' | 'RESTORED' | 'REVOKED', string>;
    driveRecords: Record<'PUBLISHED' | 'ARCHIVED' | 'RESTORED' | 'REVOKED', string>; sizeBytes: number;
  };
  expect(f.synthetic && f.noProvider).toBe(true);
  const origin = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [reader, other, revoked] = await Promise.all(contexts.map(c => c.newPage()));
  async function login(page: Page, email: string) {
    await page.goto(origin + '/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
    await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
    await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(origin + '/dashboard');
  }
  await login(reader, f.readerEmail); await login(other, f.otherEmail); await login(revoked, f.revokedEmail);
  await reader.goto(origin + '/videos');
  await expect(reader.getByText('SYNTHETIC_VIDEO_RECOVERY PUBLISHED', { exact: true })).toBeVisible();
  for (const mode of ['ARCHIVED', 'RESTORED', 'REVOKED']) await expect(reader.getByText('SYNTHETIC_VIDEO_RECOVERY ' + mode, { exact: true })).toHaveCount(0);
  await reader.goto(origin + '/videos/' + f.records.PUBLISHED);
  const video = reader.locator('video'); await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate(async (v: HTMLVideoElement) => { v.muted = true; await v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.1);
  const content = origin + '/videos/' + f.records.PUBLISHED + '/content';
  expect((await reader.request.get(content, { headers: { Range: 'bytes=0-15' } })).status()).toBe(206);
  expect((await reader.request.head(content)).status()).toBe(200);
  expect((await reader.request.get(content + '?download=1')).status()).toBe(200);
  expect((await other.request.get(content)).status()).toBe(404);
  for (const mode of ['ARCHIVED', 'RESTORED'] as const) expect((await reader.request.get(origin + '/videos/' + f.records[mode] + '/content')).status()).toBe(404);
  expect((await revoked.request.get(origin + '/videos/' + f.records.REVOKED + '/content')).status()).toBe(404);
  // The external frame is a local synthetic response. This checks the retained
  // player/CSP and CRM authorization, never Google availability or real access.
  await reader.route('https://drive.google.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>SYNTHETIC_DRIVE_PLAYER</p>' }));
  await reader.goto(origin + '/videos');
  await expect(reader.getByText('SYNTHETIC_DRIVE_RECOVERY PUBLISHED', { exact: true })).toBeVisible();
  for (const mode of ['ARCHIVED', 'RESTORED', 'REVOKED']) await expect(reader.getByText('SYNTHETIC_DRIVE_RECOVERY ' + mode, { exact: true })).toHaveCount(0);
  const drive = origin + '/videos/drive/' + f.driveRecords.PUBLISHED;
  const page = await reader.goto(drive);
  const headers = page?.headers() ?? {};
  expect(headers['content-security-policy'] ?? headers['content-security-policy-report-only']).toContain('frame-src');
  await reader.getByRole('button', { name: 'Apri player Google Drive', exact: true }).click();
  await expect(reader.frameLocator('iframe[title="Player Google Drive"]').getByText('SYNTHETIC_DRIVE_PLAYER', { exact: true })).toBeVisible();
  expect((await reader.request.get(drive + '/access')).status()).toBe(200);
  await expect(reader.getByRole('link', { name: /Scarica|Gestisci/ })).toHaveCount(0);
  for (const path of [drive, drive + '/access']) expect((await other.request.get(path)).status()).toBe(404);
  for (const mode of ['ARCHIVED', 'RESTORED'] as const) {
    const denied = origin + '/videos/drive/' + f.driveRecords[mode];
    expect((await reader.request.get(denied)).status()).toBe(404);
    expect((await reader.request.get(denied + '/access')).status()).toBe(404);
  }
  const denied = origin + '/videos/drive/' + f.driveRecords.REVOKED;
  expect((await revoked.request.get(denied)).status()).toBe(404);
  expect((await revoked.request.get(denied + '/access')).status()).toBe(404);
  for (const c of contexts) await c.close();
});
