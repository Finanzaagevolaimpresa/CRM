import { test, expect, type Page, type Browser } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient();
type Person = { id: string; email: string; name: string };
const f = JSON.parse(readFileSync(path.join(process.env.SELECTED_CONTENT_EVIDENCE!, 'fixture.json'), 'utf8')) as {
  threadId: string; mailboxId: string; mailboxAddress: string; people: Record<string, Person>;
};
const password = process.env.SELECTED_CONTENT_BROWSER_PASSWORD!;
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.afterAll(async () => db.$disconnect());
async function session(browser: Browser, name: string, stepUp = false) {
  const context = await browser.newContext();
  // Google authentication and playback are not simulated as a real Google PASS.
  // No external network: the frame explicitly displays a fixture-only denial.
  await context.route('https://drive.google.com/**', route => route.fulfill({ status: 403, contentType: 'text/html',
    body: '<h1>Fixture Google: accesso non disponibile</h1>' }));
  await context.route(/^https?:\/\/(?!127\.0\.0\.1:3049|drive\.google\.com)/, route => route.abort());
  const page = await context.newPage();
  await page.goto('/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(f.people[name].email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  if (stepUp) {
    await page.goto('/settings/security');
    await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Conferma per 30 minuti', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible();
  }
  return { page, context };
}
async function editor(page: Page, id: string) {
  await page.goto('/videos/manage/drive/' + id);
  await page.locator('[data-testid="drive-video-editor"][data-interactive-ready="true"]').waitFor();
}
async function confirm(page: Page, operation: string) {
  const creating = page.url().endsWith('/videos/manage/drive/new');
  const priorIds = creating ? new Set((await db.adminRecordRevision.findMany({
    where: { model: 'DriveVideoReference', operation: 'CREATE' }, select: { recordId: true },
  })).map(row => row.recordId)) : new Set<string>();
  await page.getByRole('button', { name: operation, exact: true }).click();
  await page.getByLabel('Confermo il riepilogo esatto', { exact: true }).check();
  await page.getByRole('button', { name: 'Conferma operazione', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Riapri la scheda salvata', exact: true })).toBeVisible();
  if (creating) {
    // A refreshed /new response allocates another proposed ID. The completed
    // command must still open the one persisted reference, without another save.
    const created = await db.adminRecordRevision.findMany({
      where: { model: 'DriveVideoReference', operation: 'CREATE' }, select: { recordId: true },
    });
    expect(created).toHaveLength(priorIds.size + 1);
    const added = created.filter(row => !priorIds.has(row.recordId));
    expect(added).toHaveLength(1);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('link', { name: 'Riapri la scheda salvata', exact: true }))
      .toHaveAttribute('href', '/videos/manage/drive/' + added[0].recordId);
  }
  const href = await page.getByRole('link', { name: 'Riapri la scheda salvata', exact: true }).getAttribute('href');
  await page.getByRole('link', { name: 'Riapri la scheda salvata', exact: true }).click();
  return href!.split('/').at(-1)!;
}
test('Drive invalid URL, private draft, exact audiences, technical/commercial viewing and current revocation', async ({ browser }) => {
  const admin = await session(browser, 'admin', true), commercial = await session(browser, 'commercial'),
    technical = await session(browser, 'technical'), other = await session(browser, 'unselected');
  try {
    await editor(admin.page, 'new');
    await admin.page.getByLabel('Link del video Google Drive', { exact: true }).fill('https://evil.invalid/not-drive');
    await admin.page.getByLabel('Confermo che il file appartiene al Drive', { exact: false }).check();
    await admin.page.getByLabel('Titolo', { exact: true }).fill('Synthetic selective Drive clip');
    await admin.page.getByRole('button', { name: 'Salva bozza privata', exact: true }).click();
    await expect(admin.page.getByRole('status')).toContainText('Controlla il link');
    await admin.page.getByLabel('Link del video Google Drive', { exact: true }).fill('https://drive.google.com/file/d/synthetic_neutral_not_a_real_id_001/view');
    for (const key of ['commercial','technical']) await admin.page.getByLabel(f.people[key].name + ' · ' + f.people[key].email, { exact: false }).check();
    const id = await confirm(admin.page, 'Salva bozza privata');
    await expect(admin.page.getByLabel('Titolo', { exact: true })).toHaveValue('Synthetic selective Drive clip');
    expect(await db.adminRecordRevision.count({ where: { model: 'DriveVideoReference', operation: 'CREATE' } })).toBe(1);
    await commercial.page.goto('/videos/drive/' + id); await expect(commercial.page.getByText('Synthetic selective Drive clip', { exact: true })).toHaveCount(0);
    await admin.page.reload(); await expect(admin.page.getByLabel('Titolo', { exact: true })).toHaveValue('Synthetic selective Drive clip');
    await admin.page.getByLabel('Ho verificato video, titolo e descrizione', { exact: false }).check();
    await confirm(admin.page, 'Pubblica per le persone scelte');
    for (const viewer of [commercial, technical]) {
      await viewer.page.goto('/videos'); await viewer.page.getByRole('link', { name: 'Guarda video', exact: true }).click();
      await expect(viewer.page.getByRole('heading', { name: 'Synthetic selective Drive clip', exact: true })).toBeVisible();
      await expect(viewer.page.getByRole('link', { name: 'Gestisci video e destinatari', exact: true })).toHaveCount(0);
      await viewer.page.getByRole('button', { name: 'Apri player Google Drive', exact: true }).click();
      await expect(viewer.page.frameLocator('iframe[title="Player Google Drive"]').getByRole('heading')).toHaveText('Fixture Google: accesso non disponibile');
      await expect(viewer.page.getByText('Se Google mostra', { exact: false })).toBeVisible();
      await expect(viewer.page.getByRole('link', { name: 'Apri su Google Drive', exact: true })).toBeVisible();
    }
    await other.page.goto('/videos/drive/' + id); await expect(other.page.locator('iframe')).toHaveCount(0);
    expect((await other.page.request.get('/videos/drive/' + id + '/access')).status()).toBe(404);
    await confirm(admin.page, 'Archivia e revoca il riferimento');
    await expect(technical.page.getByText('Riferimento non più disponibile', { exact: false })).toBeVisible({ timeout: 15000 });
    await expect(technical.page.locator('iframe')).toHaveCount(0);
    await confirm(admin.page, 'Ripristina in bozza');
    await commercial.page.reload(); await expect(commercial.page.locator('iframe')).toHaveCount(0);
    await admin.page.getByLabel('Ho verificato video, titolo e descrizione', { exact: false }).check();
    await confirm(admin.page, 'Pubblica per le persone scelte');
    await technical.page.reload(); await expect(technical.page.getByRole('button', { name: 'Apri player Google Drive' })).toBeVisible();
    await confirm(admin.page, 'Archivia e revoca il riferimento');
  } finally { for (const item of [admin, commercial, technical, other]) await item.context.close(); }
});
test('Admin explicit technical permissions persist and match selectors without exposing financial controls', async ({ browser }) => {
  const admin = await session(browser, 'admin', true);
  try {
    await admin.page.goto('/settings/users/' + f.people.technical.id);
    const read = admin.page.locator('select[name="permission:communications.internal.read"]'), video = admin.page.locator('select[name="permission:video.read"]');
    await expect(read).toBeEnabled(); await expect(video).toBeEnabled();
    await expect(read).toHaveValue('allow'); await expect(video).toHaveValue('allow');
    for (const code of ['payment.read','contract.read','video.manage']) await expect(admin.page.locator('select[name="permission:' + code + '"]')).toBeDisabled();
    await read.selectOption('deny');
    const form = read.locator('xpath=ancestor::form');
    await form.getByRole('button', { name: /Salva/ }).click();
    await expect(admin.page.getByRole('link', { name: 'Riapri account e permessi', exact: true })).toBeVisible();
    await admin.page.getByRole('link', { name: 'Riapri account e permessi', exact: true }).click();
    await expect(admin.page.locator('select[name="permission:communications.internal.read"]')).toHaveValue('deny');
    for (const code of ['video.manage', 'user.write', 'legal.read']) {
      await expect(admin.page.locator('select[name="permission:' + code + '"]')).toBeDisabled();
      await expect(admin.page.locator('select[name="permission:' + code + '"]')).toHaveValue('deny');
    }
    await admin.page.locator('select[name="permission:communications.internal.read"]').selectOption('allow');
    await admin.page.locator('select[name="permission:communications.internal.read"]').locator('xpath=ancestor::form').getByRole('button', { name: /Salva/ }).click();
    await expect(admin.page.getByRole('link', { name: 'Riapri account e permessi', exact: true })).toBeVisible();
    await admin.page.getByRole('link', { name: 'Riapri account e permessi', exact: true }).click();
    await expect(admin.page.locator('select[name="permission:communications.internal.read"]')).toHaveValue('allow');
    for (const code of ['video.manage', 'user.write', 'legal.read']) await expect(admin.page.locator('select[name="permission:' + code + '"]')).toHaveValue('deny');
  } finally { await admin.context.close(); }
});
test('a commercial account entering the technical function preserves newly disabled choices before save and after reopen', async ({ browser }) => {
  const admin = await session(browser, 'admin', true);
  try {
    await admin.page.goto('/settings/users/' + f.people.second.id);
    const legal = admin.page.locator('select[name="permission:legal.read"]');
    const users = admin.page.locator('select[name="permission:user.write"]');
    const technical = admin.page.locator('select[name="permission:technical.write"]');
    await expect(legal).toBeEnabled(); await expect(users).toBeEnabled();
    await expect(legal).toHaveValue('deny'); await expect(users).toHaveValue('allow');
    await legal.selectOption('allow'); await users.selectOption('deny');
    await technical.selectOption('allow');
    await expect(legal).toBeDisabled(); await expect(users).toBeDisabled();
    // Once immutable, the preview shows the server-stored values that will be preserved.
    await expect(legal).toHaveValue('deny'); await expect(users).toHaveValue('allow');
    await technical.locator('xpath=ancestor::form').getByRole('button', { name: /Salva/ }).click();
    await expect(admin.page.getByRole('link', { name: 'Riapri account e permessi', exact: true })).toBeVisible();
    await admin.page.getByRole('link', { name: 'Riapri account e permessi', exact: true }).click();
    await expect(technical).toHaveValue('allow');
    for (const [code, value] of [['legal.read', 'deny'], ['user.write', 'allow']]) {
      const row = admin.page.locator('[data-permission-code="' + code + '"]');
      await expect(row.locator('select')).toBeDisabled(); await expect(row.locator('select')).toHaveValue(value);
      await expect(row).toContainText('Effettivo: negato');
    }
    await admin.page.reload();
    const saved = await db.userPermissionOverride.findMany({ where: { userId: f.people.second.id } });
    expect(saved.find(row => row.permission === 'legal.read')?.allowed).toBe(false);
    expect(saved.find(row => row.permission === 'user.write')?.allowed).toBe(true);
  } finally { await admin.context.close(); }
});

test('Admin reopens audited restoration without replaying any allow or losing the existing selected-content choices', async ({ browser }) => {
  const admin = await session(browser, 'admin', true);
  try {
    await admin.page.goto('/settings/users/' + f.people.backoffice.id);
    const form = admin.page.getByRole('form', { name: 'Ripristino dinieghi documentati', exact: true });
    await expect(form).toBeVisible();
    await form.getByLabel('Confermo il ripristino dei soli dinieghi elencati dallo storico.', { exact: true }).check();
    await form.getByRole('button', { name: 'Ripristina dinieghi documentati', exact: true }).click();
    await expect(admin.page.getByRole('link', { name: 'Riapri account e permessi', exact: true })).toBeVisible();
    await admin.page.getByRole('link', { name: 'Riapri account e permessi', exact: true }).click();
    await expect(admin.page.getByRole('form', { name: 'Ripristino dinieghi documentati', exact: true })).toHaveCount(0);
    for (const code of ['video.manage', 'user.write', 'legal.read']) await expect(admin.page.locator('select[name="permission:' + code + '"]')).toHaveValue('deny');
    for (const code of ['video.read', 'communications.internal.read']) await expect(admin.page.locator('select[name="permission:' + code + '"]')).toHaveValue('allow');
    await admin.page.reload();
    expect(await db.auditLog.count({ where: { entityId: f.people.backoffice.id, event: 'user_permission_denials_restored' } })).toBe(1);
  } finally { await admin.context.close(); }
});
test('six CRM participants and four To recipients survive reload; approval publishes only text to technical and commercial', async ({ browser }) => {
  const admin = await session(browser, 'admin', true), technical = await session(browser, 'technical'), commercial = await session(browser, 'commercial'),
    other = await session(browser, 'unselected');
  const route = '/communications?kind=INTERNAL&practice=' + f.threadId;
  try {
    await admin.page.goto(route);
    const draft = admin.page.locator('form').filter({ has: admin.page.locator('select[name="mailboxId"]') }).first();
    await draft.getByLabel('Mittente', { exact: true }).selectOption(f.mailboxId);
    await draft.getByLabel('Reply-To', { exact: true }).fill(f.mailboxAddress);
    const recipients = draft.getByRole('region', { name: 'Destinatari A', exact: true });
    await recipients.getByText('Persone e reparti interni', { exact: true }).click();
    for (const key of ['admin','commercial','second','direction']) await recipients.getByLabel(f.people[key].name + ' · ' + f.people[key].email, { exact: true }).check();
    await draft.getByLabel('Oggetto', { exact: true }).fill('Synthetic six participant test');
    await draft.getByLabel('Testo esatto', { exact: true }).fill('SYNTHETIC_SELECTED_TEXT_ONLY');
    await draft.locator('input[name="shareInternalText"]').check();
    await draft.getByRole('button', { name: 'Salva bozza', exact: true }).click();
    await expect(admin.page.getByRole('region', { name: 'Testo del messaggio conservato', exact: true })).toHaveText('SYNTHETIC_SELECTED_TEXT_ONLY');
    await admin.page.reload();
    const message = await db.approvedCommunication.findFirstOrThrow({ where: { internalThreadId: f.threadId }, include: { versions: true } });
    const snapshot = message.versions[0].snapshot as { to: string[]; cc: string[]; bcc: string[]; body: string };
    expect(snapshot.to.sort()).toEqual(['admin','commercial','second','direction'].map(k => f.people[k].email).sort());
    expect(snapshot.cc).toEqual([]); expect(snapshot.bcc).toEqual([]);
    await technical.page.goto(route); await expect(technical.page.getByText('SYNTHETIC_SELECTED_TEXT_ONLY', { exact: true })).toHaveCount(0);
    await admin.page.getByRole('button', { name: 'Richiedi approvazione admin', exact: true }).click();
    const approval = admin.page.locator('input[name="exactApproval"]').locator('xpath=ancestor::form');
    await approval.locator('input[name="exactApproval"]').check();
    await approval.getByRole('button', { name: /Approva/ }).click();
    await expect(admin.page.getByText('Versione approvata per la lettura dei partecipanti selezionati.', { exact: false })).toBeVisible();
    for (const reader of [technical, commercial]) {
      await reader.page.goto(route); await expect(reader.page.getByText('SYNTHETIC_SELECTED_TEXT_ONLY', { exact: true })).toBeVisible();
      await expect(reader.page.getByText(f.mailboxAddress, { exact: true })).toHaveCount(0);
      await expect(reader.page.getByRole('button', { name: /Approva|Invia|Salva bozza/ })).toHaveCount(0);
    }
    await other.page.goto(route); await expect(other.page.getByText('SYNTHETIC_SELECTED_TEXT_ONLY', { exact: true })).toHaveCount(0);
    expect(await db.ordinaryEmailAttempt.count()).toBe(0);
  } finally { for (const item of [admin, technical, commercial, other]) await item.context.close(); }
});

test('numbered library and management preserve exact authorized sets, search and reload without record writes', async ({ browser }) => {
  test.setTimeout(360000);
  const admin = await session(browser, 'admin', true), commercial = await session(browser, 'commercial'),
    technical = await session(browser, 'technical'), other = await session(browser, 'unselected');
  const ids: string[] = [], title = (n: number) => String(n).padStart(2, '0') + ' - Synthetic order lesson';
  try {
    for (const n of [2, 10, 9, 12, 6, 13, 4, 3, 1, 11, 5, 8, 7]) {
      await editor(admin.page, 'new');
      await admin.page.getByLabel('Link del video Google Drive', { exact: true })
        .fill('https://drive.google.com/file/d/synthetic_order_not_a_real_file_' + String(n).padStart(2, '0') + '/view');
      await admin.page.getByLabel('Confermo che il file appartiene al Drive', { exact: false }).check();
      await admin.page.getByLabel('Titolo', { exact: true }).fill(title(n));
      await admin.page.getByLabel('Descrizione', { exact: true }).fill('Synthetic numbered order course');
      const viewers = ['admin', ...(n % 2 ? ['commercial'] : []), ...(n % 3 === 0 ? ['technical'] : [])];
      for (const key of viewers) await admin.page.getByLabel(f.people[key].name + ' · ' + f.people[key].email, { exact: false }).check();
      await admin.page.getByLabel('Ho verificato video, titolo e descrizione', { exact: false }).check();
      ids.push(await confirm(admin.page, 'Salva bozza privata'));
      await confirm(admin.page, 'Pubblica per le persone scelte');
    }
    const snapshot = () => db.adminRecordRevision.findMany({
      where: { model: 'DriveVideoReference', recordId: { in: ids } },
      select: { commandId: true, recordId: true, operation: true, afterHash: true }, orderBy: { commandId: 'asc' },
    });
    const before = await snapshot();
    const all = Array.from({ length: 13 }, (_, i) => i + 1);
    const readers: Array<[typeof admin, number[]]> = [[admin, all], [commercial, all.filter(n => n % 2)],
      [technical, all.filter(n => n % 3 === 0)], [other, []]];
    for (const [viewer, numbers] of readers) {
      await viewer.page.goto('/videos');
      await expect(viewer.page.locator('article h2')).toHaveText(numbers.map(title));
      await viewer.page.reload();
      await expect(viewer.page.locator('article h2')).toHaveText(numbers.map(title));
      await viewer.page.getByLabel('Cerca nella libreria', { exact: true }).fill('numbered order course');
      await viewer.page.getByRole('button', { name: 'Cerca', exact: true }).click();
      await expect(viewer.page.locator('article h2')).toHaveText(numbers.map(title));
      await viewer.page.getByLabel('Cerca nella libreria', { exact: true }).fill(title(10));
      await viewer.page.getByRole('button', { name: 'Cerca', exact: true }).click();
      await expect(viewer.page.locator('article h2')).toHaveText(numbers.includes(10) ? [title(10)] : []);
      await viewer.page.reload();
      await expect(viewer.page.locator('article h2')).toHaveText(numbers.includes(10) ? [title(10)] : []);
    }
    await admin.page.goto('/videos/manage');
    await expect(admin.page.locator('article h3').filter({ hasText: /^\d{2} - Synthetic order lesson$/ })).toHaveText(all.map(title));
    await admin.page.reload();
    await expect(admin.page.locator('article h3').filter({ hasText: /^\d{2} - Synthetic order lesson$/ })).toHaveText(all.map(title));
    for (const viewer of [commercial, technical, other]) {
      await viewer.page.goto('/videos/manage');
      await expect(viewer.page.getByRole('heading', { name: 'Gestione video', exact: true })).toHaveCount(0);
    }
    expect((await other.page.request.get('/videos/drive/' + ids[0] + '/access')).status()).toBe(404);
    expect(await snapshot()).toEqual(before);
  } finally { for (const item of [admin, commercial, technical, other]) await item.context.close(); }
});
