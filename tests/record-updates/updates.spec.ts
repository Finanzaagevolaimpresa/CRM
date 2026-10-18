import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { storedNoticeMessage, linkedOrdinaryNoticeReply } from './communication-fixtures';
const db = new PrismaClient(), evidence = process.env.UPDATES_EVIDENCE!, password = process.env.UPDATES_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; readerId: string; otherId: string; readerName: string; commercialId: string; commercialName: string;
  emails: { admin: string; reader: string; other: string; commercial: string };
};
const origin = 'http://127.0.0.1:3038';
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
async function fixture(kind: 'LEAD' | 'CLIENT' | 'PROJECT' | 'PRACTICE' = 'LEAD') {
  const label = 'Aggiornamento sintetico ' + randomUUID(); let id: string;
  if (kind === 'LEAD') id = (await db.lead.create({ data: { firstName: label, lastName: 'Test', assignedToId: f.readerId } })).id;
  else {
    const client = await db.client.create({ data: { type: 'societa', displayName: label, salesOwnerId: f.readerId } });
    if (kind === 'CLIENT') id = client.id;
    else if (kind === 'PROJECT') id = (await db.project.create({ data: { clientId: client.id, title: label } })).id;
    else id = (await db.technicalPractice.create({ data: { clientId: client.id, title: label, practiceType: 'test',
      targetEntity: 'synthetic', createdById: f.adminId } })).id;
  }
  return { kind, id, label };
}
async function open(page: Page, row: Awaited<ReturnType<typeof fixture>>) {
  await page.goto('/record-updates/' + row.kind + '/' + row.id);
  const form = page.getByTestId('record-update-form');
  await expect(form).toHaveAttribute('data-interactive-ready', 'true'); return form;
}
async function preview(page: Page, row: Awaited<ReturnType<typeof fixture>>, persistent = false) {
  const form = await open(page, row);
  await form.getByRole('checkbox', { name: new RegExp(f.readerName) }).check();
  if (row.kind === 'LEAD') await form.getByLabel('Prossima azione: descrizione', { exact: true }).fill('Contenuto privato sintetico');
  else if (row.kind === 'CLIENT') await form.getByLabel('Denominazione', { exact: true }).fill(row.label + ' modificato');
  else await form.getByLabel('Stato', { exact: true }).selectOption(row.kind === 'PROJECT' ? 'in_analisi' : 'in_progettazione');
  if (persistent) await form.getByRole('checkbox', { name: 'Attiva anche una regola per questa scheda' }).check();
  await form.getByRole('button', { name: 'Controlla destinatari e modifiche' }).click();
  await expect(page.getByRole('region', { name: 'Riepilogo aggiornamento' })).toBeVisible();
  await page.getByRole('checkbox', { name: /^Confermo questa operazione, i destinatari ammessi e la modalità/ }).check();
}
async function confirm(page: Page) {
  await page.getByRole('button', { name: 'Salva e aggiorna', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Operazione registrata');
}
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(f.synthetic).toBe(true); });
test.afterAll(async () => db.$disconnect());

test('native four-context save, persistent rule and revocation; only selected current recipients see notices, desktop/mobile fit', async ({ browser }) => {
  const ac = await browser.newContext(), rc = await browser.newContext(), oc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage(), other = await oc.newPage();
  await login(admin, f.emails.admin, true); await login(reader, f.emails.reader); await login(other, f.emails.other);
  let lead: Awaited<ReturnType<typeof fixture>> | undefined;
  for (const kind of ['LEAD', 'CLIENT', 'PROJECT', 'PRACTICE'] as const) {
    const row = await fixture(kind);
    if (kind === 'LEAD') lead = row;
    await preview(admin, row, kind === 'LEAD');
    await admin.setViewportSize({ width: kind === 'PRACTICE' ? 390 : 1440, height: kind === 'PRACTICE' ? 844 : 1000 });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await admin.screenshot({ path: path.join(evidence, 'updates-' + kind.toLowerCase() + '-preview.png'), fullPage: true });
    await confirm(admin);
    const work = await db.recordUpdateDelivery.findMany({ where: { event: { recordId: row.id } } });
    expect(work).toHaveLength(1); expect(work[0].recipientId).toBe(f.readerId); expect(work[0].readAt).toBeNull();
    await reader.goto('/notifications/updates/' + work[0].id);
    await expect(reader.getByRole('link', { name: 'Apri scheda' })).toBeVisible();
    expect((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: work[0].id } })).readAt).toBeNull();
    const denied = await oc.request.get('/notifications/updates/' + work[0].id);
    expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain(row.label);
  }
  await db.lead.update({ where: { id: lead!.id }, data: { nextActionDate: new Date('2027-02-01T10:00:00Z') } });
  const ruleWork = await db.recordUpdateDelivery.findFirstOrThrow({ where: { event: { recordId: lead!.id }, ruleId: { not: null } } });
  await reader.goto('/notifications/updates/' + ruleWork.id);
  await expect(reader.getByRole('link', { name: 'Apri scheda' })).toBeVisible();
  await admin.setViewportSize({ width: 390, height: 844 }); await open(admin, lead!);
  await admin.getByRole('button', { name: 'Revoca regola', exact: true }).click();
  await admin.getByRole('checkbox', { name: /^Confermo questa operazione, i destinatari ammessi e la modalità/ }).check();
  await admin.getByRole('button', { name: 'Conferma revoca', exact: true }).click();
  await expect(admin.getByRole('status')).toContainText('Operazione registrata');
  expect((await rc.request.get('/notifications/updates/' + ruleWork.id)).status()).toBe(404);
  expect((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: ruleWork.id } })).readAt).toBeNull();
  await reader.goto('/notifications/updates'); await reader.screenshot({ path: path.join(evidence, 'updates-history.png'), fullPage: true });
  await ac.close(); await rc.close(); await oc.close();
});
test('an open preview cannot save after its native registry session is revoked', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(), row = await fixture();
  await login(page, f.emails.admin, true); await preview(page, row);
  await db.internalSession.updateMany({ where: { userId: f.adminId, revokedAt: null }, data: { revokedAt: new Date() } });
  await page.getByRole('button', { name: 'Salva e aggiorna', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await db.recordUpdateDelivery.count({ where: { event: { recordId: row.id } } })).toBe(0);
  expect((await db.lead.findUniqueOrThrow({ where: { id: row.id } })).nextActionNote).toBeNull();
  await context.close();
});
test('lost confirmation response freezes repeat writes; explicit receipt lookup and replay prove one save', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(), row = await fixture();
  await login(page, f.emails.admin, true); await preview(page, row);
  let captured: { url: string; body: string; headers: Record<string, string> } | undefined;
  let done!: () => void, fail!: (e: unknown) => void;
  const aborted = new Promise<void>((r, j) => { done = r; fail = j; });
  await page.route('**/record-updates/**', async route => {
    const req = route.request();
    if (req.method() !== 'POST' || !req.headers()['next-action']) return route.continue();
    try {
      captured = { url: req.url(), body: req.postData()!, headers: { 'next-action': req.headers()['next-action'], 'content-type': req.headers()['content-type'], origin } };
      const response = await route.fetch({ maxRedirects: 0 }); expect(response.status()).toBeLessThan(500);
      await route.abort('failed'); done();
    } catch (error) { fail(error); }
  });
  await page.getByRole('button', { name: 'Salva e aggiorna', exact: true }).click(); await aborted;
  await page.unroute('**/record-updates/**');
  await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  expect(await db.recordUpdateDelivery.count({ where: { event: { recordId: row.id } } })).toBe(1);
  await page.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('salvataggio è già registrato');
  expect(captured).toBeTruthy();
  await context.request.post(captured!.url, { headers: captured!.headers, data: captured!.body });
  expect(await db.recordUpdateDelivery.count({ where: { event: { recordId: row.id } } })).toBe(1);
  expect(await db.recordUpdateCommand.count({ where: { recordId: row.id } })).toBe(1);
  await context.close();
});

test('non-Admin notices use native source privacy; late restriction/conflict denies stale read POST and all counts', async ({ browser }) => {
  test.setTimeout(480_000);
  const ac = await browser.newContext(), rc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage();
  await login(admin, f.emails.admin, true); await login(reader, f.emails.commercial);
  let actionName = '';
  for (const restriction of ['ORDINARY', 'restricted', 'COMPLAINT', 'SENSITIVE', 'conflict'] as const) {
    const label = 'Sorgente sintetica ' + restriction + ' ' + randomUUID();
    const lead = await db.lead.create({ data: { firstName: label, lastName: 'Test', assignedToId: f.commercialId } });
    const form = await open(admin, { kind: 'LEAD', id: lead.id, label });
    await form.getByRole('combobox', { name: /^Operazione/ }).selectOption('RULE');
    await form.getByRole('checkbox', { name: new RegExp(f.commercialName) }).check();
    await form.getByRole('button', { name: 'Controlla destinatari e modifiche' }).click();
    await expect(admin.getByRole('region', { name: 'Riepilogo aggiornamento' })).toBeVisible();
    await admin.getByRole('checkbox', { name: /^Confermo questa operazione, i destinatari ammessi e la modalità/ }).check();
    await admin.getByRole('button', { name: 'Attiva regola', exact: true }).click();
    await expect(admin.getByRole('status')).toContainText('Operazione registrata');
    await reader.goto('/notifications');
    const baselineCount = await reader.getByText(/^\d+ attive$/).textContent();
    const { message, mailbox } = await storedNoticeMessage(db, { leadId: lead.id, authorId: f.adminId,
      mailboxAddress: restriction === 'restricted' ? 'info@finanzaagevolaimpresa.it' : undefined,
      classification: restriction === 'COMPLAINT' || restriction === 'SENSITIVE' ? restriction : 'ORDINARY' });
    const linked = restriction === 'conflict' ? await linkedOrdinaryNoticeReply(db, message.id, mailbox.id, f.adminId) : null;
    if (!linked) await db.approvedCommunication.update({ where: { id: message.id }, data: { state: 'SENT' } });
    const work = await db.recordUpdateDelivery.findFirstOrThrow({ where: { event: { recordId: lead.id } } });
    expect(work.recipientId).toBe(f.commercialId);
    const href = '/notifications/updates/' + work.id;
    try {
      if (restriction === 'ORDINARY' || restriction === 'restricted' || linked) {
        await reader.goto('/notifications/updates');
        await expect(reader.locator('a[href="' + href + '"]')).toHaveCount(1);
        await reader.goto('/notifications');
        expect(await reader.getByText(/^\d+ attive$/).textContent()).not.toBe(baselineCount);
        await reader.goto(href); await expect(reader.getByRole('button', { name: 'Segna come letto' })).toBeVisible();
        const readForm = reader.locator('form').filter({ has: reader.getByRole('button', { name: 'Segna come letto', exact: true }) });
        await expect(readForm).toHaveCount(1);
        await expect(readForm.locator('input[name="id"]')).toHaveValue(work.id);
        const names = await readForm.locator('input').evaluateAll(inputs => inputs.map(input => input.getAttribute('name') ?? ''));
        const actionNames = names.filter(name => name.startsWith('$ACTION_ID_'));
        expect(actionNames).toHaveLength(1);
        actionName = actionNames[0];
        expect(actionName).toMatch(/^\$ACTION_ID_/);
        expect((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: work.id } })).readAt).toBeNull();
      }
      if (restriction === 'restricted') await db.communicationMailbox.update({ where: { id: mailbox.id }, data: { restricted: true } });
      if (linked) await linked.conflict();
      // The same actual form action is first proven by the ORDINARY positive
      // control. Subsequent POSTs cannot pass merely by using an invalid action.
      const response = await rc.request.post(href, { headers: { origin }, multipart: { [actionName]: '', id: work.id } });
      expect([200, 303, 404]).toContain(response.status());
      expect(new URL(response.url()).pathname).toBe(href);
      const row = await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: work.id } });
      if (restriction === 'ORDINARY') expect(row.readAt).not.toBeNull();
      else {
        expect(row.readAt).toBeNull();
        const detail = await rc.request.get(href);
        expect(detail.status()).toBe(404); expect(await detail.text()).not.toContain(label);
        await reader.goto('/notifications/updates');
        await expect(reader.locator('a[href="' + href + '"]')).toHaveCount(0);
        await expect(reader.getByText(label, { exact: true })).toHaveCount(0);
      }
      await reader.goto('/notifications');
      await expect(reader.getByText(/^\d+ attive$/)).toHaveText(baselineCount!);
      await expect(reader.locator('a[href="' + href + '"]')).toHaveCount(0);
      expect(await reader.content()).not.toContain('PRIVATE SYNTHETIC');
      if (restriction === 'conflict') {
        await reader.setViewportSize({ width: 390, height: 844 });
        await reader.screenshot({ path: path.join(evidence, 'updates-non-admin-quarantine.png'), fullPage: true });
        expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    } finally {
      if (restriction === 'restricted') await db.communicationMailbox.update({ where: { id: mailbox.id }, data: { restricted: false } });
    }
  }
  await ac.close(); await rc.close();
});


async function emailUpdate(page: Page, row: Awaited<ReturnType<typeof fixture>>, persistent = false) {
  const form = await open(page, row);
  await form.getByRole('checkbox', { name: new RegExp(f.readerName) }).check();
  await form.getByLabel('Modalità di aggiornamento', { exact: true }).selectOption('EMAIL_DRAFT');
  if (row.kind === 'LEAD') await form.getByLabel('Prossima azione: descrizione', { exact: true }).fill('PRIVATE CONTENT MUST NOT BE COPIED');
  else if (row.kind === 'CLIENT') await form.getByLabel('Denominazione', { exact: true }).fill(row.label + ' nuovo');
  else await form.getByLabel('Stato', { exact: true }).selectOption('in_progettazione');
  if (persistent) await form.getByRole('checkbox', { name: 'Attiva anche una regola per questa scheda' }).check();
  await form.getByRole('button', { name: 'Controlla destinatari e modifiche' }).click();
  await expect(page.getByRole('region', { name: 'Riepilogo aggiornamento' })).toContainText(f.readerName);
  await page.getByRole('checkbox', { name: /^Confermo questa operazione, i destinatari ammessi e la modalità/ }).check();
  await confirm(page);
  if (persistent) await db.lead.update({ where: { id: row.id }, data: { nextActionNote: 'Synthetic subsequent event' } });
  return db.recordUpdateDelivery.findFirstOrThrow({ where: { event: { recordId: row.id }, ...(persistent ? { ruleId: { not: null } } : {}) } });
}
async function openEmailDraft(page: Page, workId: string) {
  await page.goto('/communications/updates');
  const link = page.locator('a[href*="update=' + workId + '"]');
  await expect(link).toHaveCount(1); await link.click();
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Salva bozza', exact: true }) });
  await expect(form).toHaveCount(1);
  await form.locator('select[name="mailboxId"]').selectOption({ label: 'comunicazioni@finanzaagevolaimpresa.it · abilitata' });
  await form.getByLabel('Reply-To', { exact: true }).fill('comunicazioni@finanzaagevolaimpresa.it');
  return form;
}
test('native email proposals for lead/client/practice are explicit unapproved drafts, with current named recipient and mobile layout', async ({ browser }) => {
  test.setTimeout(480_000);
  const ac = await browser.newContext(), oc = await browser.newContext();
  const page = await ac.newPage(), other = await oc.newPage();
  await login(page, f.emails.admin, true); await login(other, f.emails.other);
  expect((await oc.request.get('/communications/updates')).status()).toBe(404);
  for (const kind of ['LEAD', 'CLIENT', 'PRACTICE'] as const) {
    const row = await fixture(kind), work = await emailUpdate(page, row);
    expect(work.mode).toBe('EMAIL_DRAFT');
    const form = await openEmailDraft(page, work.id);
    expect(await db.approvedCommunication.count({ where: { updateDeliveryId: work.id } })).toBe(0);
    await expect(form.getByRole('region', { name: 'Destinatario dell’aggiornamento' })).toContainText(f.emails.reader);
    expect(await form.getByLabel('Testo esatto', { exact: true }).inputValue()).not.toContain('PRIVATE CONTENT');
    await page.setViewportSize({ width: kind === 'CLIENT' ? 390 : 1440, height: kind === 'CLIENT' ? 844 : 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(evidence, 'update-email-' + kind.toLowerCase() + '.png'), fullPage: true });
    await form.getByRole('button', { name: 'Salva bozza', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Operazione registrata');
    const saved = await db.approvedCommunication.findUniqueOrThrow({ where: { updateDeliveryId: work.id } });
    expect(saved.state).toBe('DRAFT'); expect(saved.currentRevision).toBe(1);
    expect(await db.communicationApproval.count({ where: { version: { messageId: saved.id } } })).toBe(0);
    expect(await db.communicationAttempt.count({ where: { messageId: saved.id } })).toBe(0);
    await page.goto('/communications/updates');
    const link = page.locator('a[href*="update=' + work.id + '"]');
    await expect(link).toHaveText('Apri messaggio già salvato'); await link.click();
    await expect(page.getByRole('button', { name: 'Salva bozza', exact: true })).toHaveCount(0);
    await page.getByText('Modifica e invalida l’approvazione precedente', { exact: true }).click();
    const edit = page.locator('form[data-message-draft="' + saved.id + '"]');
    await edit.getByLabel('Testo esatto', { exact: true }).fill('Testo personale sintetico da approvare');
    await edit.getByRole('button', { name: 'Salva nuova versione da approvare', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Operazione registrata');
    expect((await db.approvedCommunication.findUniqueOrThrow({ where: { id: saved.id } })).currentRevision).toBe(2);
  }
  await ac.close(); await oc.close();
});
test('native draft form opened before rule revocation cannot materialize or expose the old proposal', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(), row = await fixture();
  await login(page, f.emails.admin, true);
  const work = await emailUpdate(page, row, true), form = await openEmailDraft(page, work.id);
  // The same persisted rule used by native revocation: no app route or source is mocked.
  await db.recordUpdateRule.update({ where: { kind_recordId: { kind: row.kind, recordId: row.id } }, data: { active: false, version: { increment: 1 } } });
  await form.getByRole('button', { name: 'Salva bozza', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Accesso o contesto non più valido');
  expect(await db.approvedCommunication.count({ where: { updateDeliveryId: work.id } })).toBe(0);
  await page.goto('/communications/updates');
  await expect(page.locator('a[href*="update=' + work.id + '"]')).toHaveCount(0);
  await context.close();
});
test('native email draft lost response and replay retain a single version and no send', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(), row = await fixture();
  await login(page, f.emails.admin, true);
  const work = await emailUpdate(page, row), form = await openEmailDraft(page, work.id);
  let captured: { url: string; body: string; headers: Record<string, string> } | undefined;
  let done!: () => void, fail!: (error: unknown) => void;
  const aborted = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
  await page.route('**/communications?**', async route => {
    const req = route.request();
    if (req.method() !== 'POST' || !req.headers()['next-action']) return route.continue();
    try {
      captured = { url: req.url(), body: req.postData()!, headers: { origin, 'next-action': req.headers()['next-action'], 'content-type': req.headers()['content-type'] } };
      const response = await route.fetch({ maxRedirects: 0 }); expect(response.status()).toBeLessThan(500);
      await route.abort('failed'); done();
    } catch (error) { fail(error); }
  });
  await form.getByRole('button', { name: 'Salva bozza', exact: true }).click(); await aborted;
  await page.unroute('**/communications?**');
  expect(captured).toBeTruthy();
  expect(await db.communicationVersion.count({ where: { messageId: work.id } })).toBe(1);
  await context.request.post(captured!.url, { headers: captured!.headers, data: captured!.body });
  expect(await db.communicationVersion.count({ where: { messageId: work.id } })).toBe(1);
  expect(await db.communicationAttempt.count({ where: { messageId: work.id } })).toBe(0);
  await page.goto('/communications/updates');
  await expect(page.locator('a[href*="update=' + work.id + '"]')).toHaveText('Apri messaggio già salvato');
  await context.close();
});
