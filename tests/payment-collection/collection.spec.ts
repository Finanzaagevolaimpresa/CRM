import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { collectionFixture, collectionKey } from './fixture';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { getHandoffReceipt } from '../../src/lib/purchased-service-handoff';

const db = new PrismaClient(), password = process.env.PAYMENT_COLLECTION_BROWSER_PASSWORD!;
let f: Awaited<ReturnType<typeof collectionFixture>>;
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(password.length).toBeGreaterThanOrEqual(24); await collectionKey(db);
});
test.beforeEach(async () => { f = await collectionFixture(db, await bcrypt.hash(password, 4)); });
test.afterAll(() => db.$disconnect());
async function login(page: Page, email = f.admin.email, proof = true) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (proof) {
    await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: /Conferma per (5|30) minuti/, exact: true }).click(); await expect(page).toHaveURL(/status=active/);
  }
}
async function prepare(page: Page) {
  await page.goto(`/payments/${f.payment.id}/collection`);
  await expect(page.getByTestId('payment-collection-form')).toHaveAttribute('data-interactive-ready', 'true');
  const date = new Date(Date.now() - 120_000).toISOString().slice(0, 16);
  await page.getByLabel('Data e ora effettive dell’incasso', { exact: true }).fill(date);
  await page.getByLabel('Prova dell’incasso', { exact: true }).selectOption(f.command.documentVersionId);
  await expect(page.getByLabel('Data e ora effettive dell’incasso', { exact: true })).toHaveValue(date);
  await page.getByRole('button', { name: 'Controlla riepilogo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo prima della conferma' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Conferma incasso', exact: true })).toBeDisabled();
  await page.getByRole('checkbox').check();
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: path.join(process.env.PAYMENT_COLLECTION_EVIDENCE!, name + '.png'), fullPage: true });
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth, width: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('main *')].map(element => {
      const box = element.getBoundingClientRect();
      return { tag: element.tagName, classes: element.getAttribute('class'), left: box.left, right: box.right, width: box.width };
    }).filter(element => element.right > window.innerWidth || element.left < 0),
  }));
  await writeFile(path.join(process.env.PAYMENT_COLLECTION_EVIDENCE!, name + '-layout.json'), JSON.stringify(layout));
  expect(layout.width).toBeLessThanOrEqual(layout.viewport);
}
async function unpaid() {
  const p = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  expect(p.status).toBe('da_incassare'); expect(p.collectedAt).toBeNull(); expect(p.accountingDocumentId).toBeNull();
  expect(await db.auditLog.count({ where: { entityId: f.payment.id, event: 'payment_collection_v1' } })).toBe(0);
}
test('Admin Incassato choice preserves its draft, opens the guarded flow and reopens the persisted state', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await login(page);
  await page.goto('/payments');
  const unpaidRow = page.getByRole('row').filter({ hasText: f.client.displayName });
  await expect(unpaidRow.getByRole('link', { name: 'Conferma pagamento · Incassato', exact: true })).toHaveAttribute('href', `/payments/${f.payment.id}/collection`);
  await expect(page.getByRole('heading', { name: 'Conferma pagamento', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crea rata da incassare', exact: true })).toBeVisible();
  await page.goto(`/admin/records/Payment/${f.payment.id}`);
  const status = page.getByRole('combobox', { name: 'Stato', exact: true });
  await expect(status).toBeEnabled();
  const notes = page.getByLabel('Note', { exact: true }), reason = page.getByRole('textbox', { name: 'Motivazione della correzione', exact: true });
  await notes.fill('Bozza sintetica non salvata'); await reason.fill('Motivo della bozza sintetica');
  await status.selectOption({ label: 'Incassato · Conferma pagamento' });
  await expect(page.getByRole('heading', { name: 'Conferma il pagamento per registrare Incassato', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Salva operazione', exact: true })).toBeDisabled();
  await page.locator('form').filter({ has: status }).evaluate(form => (form as HTMLFormElement).requestSubmit());
  await unpaid();
  expect(await db.adminRecordRevision.count({ where: { model: 'Payment', recordId: f.payment.id } })).toBe(0);
  const open = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Apri conferma pagamento', exact: true }).click();
  const collection = await open;
  try {
    await expect(collection).toHaveURL(new RegExp(`/payments/${f.payment.id}/collection$`));
    await expect(collection.getByRole('heading', { name: 'Conferma incasso', exact: true })).toBeVisible();
    await expect(notes).toHaveValue('Bozza sintetica non salvata');
    await expect(reason).toHaveValue('Motivo della bozza sintetica');
    await prepare(collection); await unpaid();
    await collection.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
    await expect(collection.getByRole('heading', { name: 'Incasso registrato', exact: true })).toBeVisible();
    await collection.getByRole('link', { name: 'Apri pagamenti e verifica lo stato', exact: true }).click();
    const row = collection.getByRole('row').filter({ hasText: f.client.displayName });
    await expect(row).toContainText('incassato');
    await expect(row.getByRole('link', { name: 'Apri incasso e verifiche', exact: true })).toBeVisible();
    await expect(row.getByRole('link', { name: 'Conferma pagamento · Incassato', exact: true })).toHaveCount(0);
    const stored = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
    expect(stored.status).toBe('incassato'); expect(stored.notes).not.toBe('Bozza sintetica non salvata');
    expect(await db.auditLog.count({ where: { entityId: f.payment.id, event: 'payment_collection_v1' } })).toBe(1);
    await expect(notes).toHaveValue('Bozza sintetica non salvata');
    await expect(reason).toHaveValue('Motivo della bozza sintetica');
  } finally { await collection.close(); }
});

test('Admin collection choice preserves the unsigned-contract guard and new installments start unpaid', async ({ page }) => {
  await db.contract.update({ where: { id: f.contract.id }, data: { status: 'da_preparare', signedAt: null, signedDocumentId: null } });
  await login(page); await page.goto(`/admin/records/Payment/${f.payment.id}`);
  const status = page.getByRole('combobox', { name: 'Stato', exact: true });
  await expect(status).toBeEnabled(); await status.selectOption({ label: 'Incassato · Conferma pagamento' });
  const open = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Apri conferma pagamento', exact: true }).click();
  const collection = await open;
  try {
    await expect(collection.getByRole('status')).toContainText('Il contratto collegato risulta «da preparare»');
    await expect(collection.getByRole('link', { name: 'Apri il contratto collegato', exact: true })).toHaveAttribute('href', `/contracts/${f.contract.id}`);
    await expect(collection.getByRole('form', { name: 'Conferma incasso', exact: true })).toHaveCount(0);
    await unpaid();
  } finally { await collection.close(); }
  await status.selectOption('da_incassare');
  await expect(page.getByRole('button', { name: 'Salva operazione', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Conferma il pagamento per registrare Incassato', exact: true })).toHaveCount(0);
  await page.goto('/admin/records/Payment/new');
  await expect(page.getByText(/La nuova rata viene creata Da incassare/)).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Stato', exact: true }).locator('option', { hasText: 'Incassato · Conferma pagamento' })).toHaveCount(0);
  await unpaid();
});

test('a linked lead opens its existing dossier only when that dossier is readable', async ({ page, browser }) => {
  const sales = await db.user.create({ data: { role: 'commerciale', name: 'Commerciale sintetico', email: `lead-${f.tag}@example.test`.toLowerCase(), passwordHash: await bcrypt.hash(password, 4) } });
  const lead = await db.lead.create({ data: { firstName: 'Lead', lastName: 'Sintetico', assignedToId: sales.id, status: 'vinto', clientId: f.client.id } });
  await db.client.update({ where: { id: f.client.id }, data: { leadId: lead.id } });
  await login(page, f.admin.email, false);
  await page.goto(`/leads/${lead.id}`);
  const dossier = page.getByRole('link', { name: 'Apri fascicolo cliente', exact: true });
  await expect(dossier).toHaveAttribute('href', `/clients/${f.client.id}`);
  await expect(page.getByRole('button', { name: 'Converti in cliente' })).toHaveCount(0);
  await dossier.click(); await expect(page).toHaveURL(new RegExp(`/clients/${f.client.id}$`));
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText('Fascicolo Cliente Interno');
  await expect(heading).toContainText(f.client.displayName);
  const salesContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3047' });
  try {
    const salesPage = await salesContext.newPage();
    await login(salesPage, sales.email, false); await salesPage.goto(`/leads/${lead.id}`);
    await expect(salesPage.getByText('Il fascicolo collegato non è disponibile nel tuo perimetro.')).toBeVisible();
    await expect(salesPage.getByRole('link', { name: 'Apri fascicolo cliente' })).toHaveCount(0);
    await expect(salesPage.getByText(f.client.displayName, { exact: true })).toHaveCount(0);
    await expect(salesPage.locator('input[name="clientId"]')).toHaveCount(0);
    await expect(salesPage.getByRole('button', { name: 'Converti in cliente' })).toHaveCount(0);
  } finally { await salesContext.close(); }
  await db.client.update({ where: { id: f.client.id }, data: { deletedAt: new Date() } });
  await page.goto(`/leads/${lead.id}`); await expect(dossier).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Converti in cliente' })).toHaveCount(0);
  expect(await db.client.count({ where: { leadId: lead.id } })).toBe(1);
});

test('a stale conversion form and a new conversion do not expose a client to a write-only sales actor', async ({ page }) => {
  const sales = await db.user.create({ data: { role: 'commerciale', name: 'Commerciale sintetico senza lettura',
    email: `write-${f.tag}@example.test`.toLowerCase(), passwordHash: await bcrypt.hash(password, 4) } });
  await db.userPermissionOverride.createMany({ data: [
    { userId: sales.id, permission: 'client.read', allowed: false },
    { userId: sales.id, permission: 'client.write', allowed: true },
    { userId: sales.id, permission: 'lead.write', allowed: true },
  ] });
  await login(page, sales.email, false);
  for (const raced of [true, false]) {
    const lead = await db.lead.create({ data: { firstName: 'Conversione', lastName: 'Sintetica', assignedToId: sales.id } });
    await page.goto(`/leads/${lead.id}`);
    const convert = page.getByRole('button', { name: 'Converti in cliente', exact: true });
    await expect(convert).toBeVisible();
    if (raced) await db.$transaction([
      db.client.update({ where: { id: f.client.id }, data: { leadId: lead.id, salesOwnerId: sales.id } }),
      db.lead.update({ where: { id: lead.id }, data: { clientId: f.client.id, status: 'vinto' } }),
    ]);
    const captured: { post?: { body: string; headers: Record<string, string> } } = {};
    const matchesLead = (url: URL) => url.pathname === `/leads/${lead.id}`;
    await page.route(matchesLead, async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      // Read the actual server response before navigation releases Chromium's body buffer.
      const post = await route.fetch({ maxRedirects: 0 });
      const body = await post.text(); captured.post = { body, headers: post.headers() };
      await route.fulfill({ response: post, body });
    });
    try {
      await convert.click();
      await expect(page.getByText('Il fascicolo collegato non è disponibile nel tuo perimetro.')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/leads/${lead.id}$`));
      const client = await db.client.findUniqueOrThrow({ where: { leadId: lead.id } });
      expect(captured.post).toBeDefined();
      expect(captured.post!.body + JSON.stringify(captured.post!.headers)).not.toContain(client.id);
      await expect(page.getByRole('link', { name: 'Apri fascicolo cliente' })).toHaveCount(0);
      await expect(convert).toHaveCount(0);
      expect(await db.client.count({ where: { leadId: lead.id } })).toBe(1);
    } finally { await page.unroute(matchesLead); }
  }
});

test('a sales form opened before acquisition of a technical function cannot convert the lead', async ({ page }) => {
  const sales = await db.user.create({ data: { role: 'commerciale', name: 'Commerciale sintetico con nuova funzione',
    email: `scope-${f.tag}@example.test`.toLowerCase(), passwordHash: await bcrypt.hash(password, 4) } });
  const lead = await db.lead.create({ data: { firstName: 'Cambio', lastName: 'Perimetro', assignedToId: sales.id } });
  await login(page, sales.email, false); await page.goto(`/leads/${lead.id}`);
  const convert = page.getByRole('button', { name: 'Converti in cliente', exact: true });
  await expect(convert).toBeVisible();
  await db.userPermissionOverride.create({ data: { userId: sales.id, permission: 'technical.write', allowed: true } });
  const pending = page.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith(`/leads/${lead.id}`));
  await convert.click();
  const response = await pending;
  expect(response.status()).toBe(404);
  expect(response.headers()['x-action-redirect'] ?? '').not.toContain('/clients/');
  expect(page.url()).not.toMatch(/\/clients\//);
  expect(await db.client.count({ where: { leadId: lead.id } })).toBe(0);
  expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).clientId).toBeNull();
  expect(await db.auditLog.count({ where: { entityId: lead.id, event: 'lead_convert_to_client' } })).toBe(0);
});

test('an archived service keeps the installment closed and points only to visible payments', async ({ page }) => {
  await db.clientService.create({ data: { clientId: f.client.id, contractId: f.contract.id, serviceCatalogId: f.catalog.id,
    paymentId: f.payment.id, deletedAt: new Date() } });
  await login(page); await page.goto(`/payments/${f.payment.id}/collection`);
  await expect(page.getByRole('status')).toContainText('La rata non è disponibile');
  await expect(page.getByRole('link', { name: 'Apri i servizi acquistati' })).toHaveCount(0);
  const payments = page.getByRole('link', { name: 'Apri i pagamenti del cliente' });
  await expect(payments).toHaveAttribute('href', `/clients/${f.client.id}#pagamenti`);
  await payments.click(); await expect(page).toHaveURL(new RegExp(`/clients/${f.client.id}#pagamenti$`));
  await unpaid();
});

test('the same contract explains a closed setup and a closure between preview and confirmation', async ({ page }) => {
  await db.contract.update({ where: { id: f.contract.id }, data: { status: 'da_preparare', signedAt: null, signedDocumentId: null } });
  await login(page); await page.goto(`/payments/${f.payment.id}/collection`);
  const link = page.getByRole('link', { name: 'Apri il contratto collegato', exact: true });
  await expect(page.getByRole('status')).toContainText('Il contratto collegato risulta «da preparare»');
  await expect(link).toHaveAttribute('href', `/contracts/${f.contract.id}`);
  await expect(page.getByRole('form', { name: 'Conferma incasso' })).toHaveCount(0);
  await link.click(); await expect(page.getByRole('heading', { name: 'Dati contratto', exact: true })).toBeVisible();
  await db.contract.update({ where: { id: f.contract.id }, data: { status: 'firmato', signedAt: new Date(Date.now() - 60_000), signedDocumentId: f.documents[0].id } });
  await page.goto(`/payments/${f.payment.id}/collection`); await prepare(page);
  await db.contract.update({ where: { id: f.contract.id }, data: { status: 'non_firmato', signedAt: null, signedDocumentId: null } });
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Il contratto collegato risulta «non firmato»');
  await expect(link).toHaveAttribute('href', `/contracts/${f.contract.id}`);
  await expect(page.getByRole('form', { name: 'Conferma incasso' })).toHaveCount(0);
  await unpaid();
});

test('desktop payment entry to exact collection preview; double click commits once', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await login(page);
  await page.goto('/payments'); await page.locator(`a[href="/payments/${f.payment.id}/collection"]`).click();
  await expect(page.getByRole('heading', { name: 'Conferma incasso', exact: true })).toBeVisible();
  await prepare(page); await unpaid(); await screenshot(page, 'desktop-preview');
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByRole('heading', { name: 'Incasso registrato', exact: true })).toBeVisible(); await screenshot(page, 'desktop-result');
  expect(await db.auditLog.count({ where: { entityId: f.payment.id, event: 'payment_collection_v1' } })).toBe(1);
  expect(await db.clientService.count({ where: { clientId: f.client.id } })).toBe(0);
});
test('mobile service registration, actual collection, explicit linking and technical handoff', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  await page.goto(`/clients/${f.client.id}/services/new`);
  await page.getByLabel('Servizio del catalogo', { exact: true }).selectOption(f.catalog.id);
  await page.getByLabel('Incarico firmato del cliente', { exact: true }).selectOption(f.contract.id);
  await page.getByLabel('Data di acquisto', { exact: true }).fill(f.registrationCommand.purchasedOn);
  await page.getByRole('button', { name: 'Controlla riepilogo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo prima della registrazione' })).toBeVisible();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Registra servizio acquistato', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Servizio registrato nel fascicolo' })).toBeVisible();
  const service = await db.clientService.findFirstOrThrow({ where: { clientId: f.client.id } }); expect(service.paymentId).toBeNull();
  await prepare(page); await screenshot(page, 'mobile-preview');
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Incasso registrato', exact: true })).toBeVisible(); await screenshot(page, 'mobile-result');
  expect((await db.clientService.findUniqueOrThrow({ where: { id: service.id } })).paymentId).toBeNull();
  await page.getByRole('link', { name: 'Apri servizi acquistati', exact: true }).click();
  await page.locator(`#service-${service.id}`).getByRole('link', { name: 'Collega pagamento', exact: true }).click();
  await page.getByLabel('Rata incassata', { exact: true }).selectOption(f.payment.id);
  await page.getByRole('button', { name: 'Controlla riepilogo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo prima della registrazione' })).toBeVisible();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Collega pagamento', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pagamento collegato al servizio' })).toBeVisible();
  expect(await db.technicalPractice.count({ where: { clientId: f.client.id } })).toBe(0);
  await page.goto(`/services/${service.id}/handoff?q=${encodeURIComponent(f.tag)}`);
  const form = page.getByRole('form', { name: 'Passaggio al tecnico', exact: true });
  await form.getByLabel('Variante prevista dall’incarico', { exact: true }).fill(f.input.variantCode);
  await form.getByLabel('Reparto tecnico', { exact: true }).fill(f.input.departmentCode);
  await form.getByLabel('Referente tecnico', { exact: true }).selectOption(f.tech.id);
  await form.getByLabel('Scadenza delle attività', { exact: true }).fill('2027-01-15');
  await form.getByLabel('Attività incluse, una per riga', { exact: true }).fill(f.input.activities.join('\n'));
  await form.getByLabel('Motivazione', { exact: true }).fill(f.input.reason); await form.getByRole('checkbox').check();
  await page.context().clearCookies({ name: 'fai_crm_privileged_step_up' });
  await form.getByRole('button', { name: 'Affida il servizio al tecnico', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferma identità senza lasciare il lavoro', exact: true })).toBeVisible();
  expect(await db.technicalPractice.count({ where: { clientId: f.client.id } })).toBe(0);
  await expect(form.getByLabel('Attività incluse, una per riga', { exact: true })).toHaveValue(f.input.activities.join('\n'));
  await page.getByLabel('Password corrente', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
  await expect(page.getByText('Identità confermata. La conferma dura 30 minuti. Le scelte sono conservate; scegli personalmente quando proseguire.', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Affida il servizio al tecnico', exact: true }).click();
  await expect.poll(async () => Boolean(await getHandoffReceipt(db, service.id))).toBe(true);
  await page.goto(`/services/${service.id}/handoff`);
  await expect(page.getByRole('heading', { name: 'Passaggio del servizio acquistato', exact: true })).toBeVisible();
  await screenshot(page, 'mobile-handoff');
  expect(await db.technicalPractice.count({ where: { clientId: f.client.id } })).toBe(1);
  expect(await db.payment.count({ where: { clientId: f.client.id } })).toBe(1);
});
test('lost response and reload reconcile the collected payment without another write', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page); await prepare(page);
  const route = `**/payments/${f.payment.id}/collection`;
  await page.route(route, async intercepted => {
    if (intercepted.request().method() === 'POST' && intercepted.request().headers()['next-action']) {
      await intercepted.fetch(); await intercepted.abort('failed'); await page.unroute(route);
    } else await intercepted.continue();
  });
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Conferma incasso', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Conferma incasso', exact: true })).toHaveCount(0);
  await page.reload(); await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Conferma incasso', exact: true })).toHaveCount(0);
  await expect(page.getByText('Questa rata risulta già incassata.', { exact: true })).toBeVisible();
  await screenshot(page, 'mobile-reconciliation');
  await page.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Incasso registrato', exact: true })).toBeVisible();
  expect(await db.auditLog.count({ where: { entityId: f.payment.id, event: 'payment_collection_v1' } })).toBe(1);
  await page.reload(); await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toHaveCount(0);
});
test('permission revocation after preview and direct technician URL deny collection', async ({ page, browser }) => {
  await login(page); await prepare(page);
  await db.userPermissionOverride.create({ data: { userId: f.admin.id, permission: 'payment.write', allowed: false } });
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Dati o autorizzazioni cambiati'); await unpaid();
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3047' }), other = await context.newPage();
  await db.contract.update({ where: { id: f.contract.id }, data: { status: 'da_preparare', signedAt: null, signedDocumentId: null } });
  await login(other, f.tech.email, false); await other.goto(`/payments/${f.payment.id}/collection`);
  await expect(other.getByText('404', { exact: true })).toBeVisible();
  await expect(other.getByRole('form', { name: 'Conferma incasso', exact: true })).toHaveCount(0);
  await expect(other.getByRole('link', { name: 'Apri il contratto collegato' })).toHaveCount(0);
  await expect(other.getByText(/Il contratto collegato risulta/)).toHaveCount(0);
  await other.goto(`/admin/records/Payment/${f.payment.id}`);
  await expect(other.getByText('404', { exact: true })).toBeVisible();
  await expect(other.getByRole('link', { name: 'Conferma pagamento · Incassato', exact: true })).toHaveCount(0);
  await expect(other.getByRole('combobox', { name: 'Stato', exact: true })).toHaveCount(0);
  await context.close();
});
test('new proof version after preview is rejected with no financial update', async ({ page }) => {
  await login(page); await prepare(page);
  await db.documentVersion.create({ data: { documentId: f.documents[1].id, version: 2, storagePath: f.documents[1].storagePath, checksum: f.documents[1].checksum } });
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('La prova non è disponibile'); await unpaid();
});
test('missing personal step-up preserves the exact collection preview and resumes once after confirmation', async ({ page }) => {
  await login(page, f.admin.email, false); await prepare(page);
  const date = await page.getByLabel('Data e ora effettive dell’incasso', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferma identità senza lasciare il lavoro', exact: true })).toBeVisible(); await unpaid();
  await expect(page.getByLabel('Data e ora effettive dell’incasso', { exact: true })).toHaveValue(date);
  await expect(page.getByLabel('Prova dell’incasso', { exact: true })).toHaveValue(f.command.documentVersionId);
  await expect(page.getByRole('checkbox')).toBeChecked();
  await page.getByLabel('Password corrente', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
  await expect(page.getByText('Identità confermata. La conferma dura 30 minuti. Le scelte sono conservate; scegli personalmente quando proseguire.', { exact: true })).toBeVisible(); await unpaid();
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Incasso registrato', exact: true })).toBeVisible();
  expect(await db.auditLog.count({ where: { entityId: f.payment.id, event: 'payment_collection_v1' } })).toBe(1);
});
test('unavailable session storage prevents an unrecoverable submission', async ({ page }) => {
  await login(page); await prepare(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('fai-payment-collection:')) throw new Error('Synthetic blocked session storage'); original.call(this, key, value); };
  });
  let posts = 0; page.on('request', request => { if (request.method() === 'POST' && request.headers()['next-action']) posts++; });
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Nessuna conferma è stata inviata'); expect(posts).toBe(0); await unpaid();
});
