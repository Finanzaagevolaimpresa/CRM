import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { INITIAL_SERVICES, INITIAL_SERVICE_LOGO_SHA256, type InitialServiceCode } from '../../src/lib/initial-service-contract';
const db = new PrismaClient(), root = process.env.M5_EVIDENCE!, password = process.env.M5_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(join(root, 'browser-fixture.json'), 'utf8'));
async function login(page: Page, role: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill('m5-browser-' + role + '@invalid.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
function form(page: Page, intent: string) { return page.locator('form').filter({ has: page.locator('input[name="intent"][value="' + intent + '"]') }); }
async function submit(page: Page, button: Locator) {
  const [response] = await Promise.all([page.waitForResponse(response => response.request().method() === 'POST' && Boolean(response.request().headers()['next-action'])), button.click()]);
  await response.finished(); expect(response.status()).toBeLessThan(400);
}
test.afterAll(async () => db.$disconnect());
test('M5 five service templates, authenticated actors, version-bound reviews, original logo export and synthetic delivery', async ({ browser }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(f.synthetic).toBe(true); expect(process.env.M5_BROWSER_CONFIRMED).toBe('1');
  const ac = await browser.newContext({ timezoneId: 'Europe/Rome' }), oc = await browser.newContext({ timezoneId: 'Europe/Rome' }), hc = await browser.newContext({ timezoneId: 'Europe/Rome' });
  const admin = await ac.newPage(), operator = await oc.newPage(), human = await hc.newPage();
  await login(admin, 'admin'); await login(operator, 'operator'); await login(human, 'human1');
  const evidence = [];
  for (const item of f.cases as Array<{ code: InitialServiceCode; dossierId: string; documentVersionId: string }>) {
    await admin.goto('/settings/security'); await admin.getByLabel('Password corrente').fill(password);
    await admin.getByRole('button', { name: 'Conferma per cinque minuti' }).click(); await expect(admin).toHaveURL(/status=active/);
    const target = '/client-dossiers/' + item.dossierId;
    await operator.goto(target); await operator.getByText('Compila il template del servizio', { exact: true }).click();
    const template = form(operator, 'template');
    for (const [index,section] of INITIAL_SERVICES[item.code].sections.entries()) await template.locator('[name="section' + index + '"]').fill(section + ': risultato sintetico completo, nessun cliente reale.');
    await template.locator('[name="sourceTitle"]').fill('Evidenza sintetica verificabile');
    await template.locator('[name="sourceReference"]').fill('SYNTHETIC_BROWSER_SOURCE');
    await template.locator('[name="sourceDate"]').fill('2026-09-27');
    await template.locator('[name="sourceLimitation"]').fill('Nessuna misura reale verificata.');
    await template.locator('[name="limits"]').fill('Solo prova sintetica della procedura.');
    await template.locator('[name="nextStep"]').fill('Risultato autonomo; nessun acquisto obbligatorio.');
    await template.getByRole('button', { name: 'Salva template come nuova versione' }).click(); await expect(operator).toHaveURL(/dossierError=RECORDED/);
    await admin.goto(target);
    const configure = form(admin, 'configure');
    await configure.locator('[name="responsibleUserId"]').selectOption(f.operatorId);
    await configure.locator('[name="human1"]').selectOption(f.human1Id);
    await configure.getByRole('button', { name: 'Salva responsabilità del servizio' }).click(); await expect(admin).toHaveURL(/dossierError=RECORDED/);
    for (const stage of ['A00','PRODUCER','Q01','Q02','Q03','HUMAN_1','D01']) {
      const page = stage === 'HUMAN_1' ? human : operator;
      await page.goto(target); const review = form(page, 'review');
      await expect(review.locator('[name="stage"]')).toHaveValue(stage);
      const na = stage === 'Q02' && item.code !== 'audit_ai_bancabilita';
      if (stage !== 'HUMAN_1') {
        if (!na) { await review.locator('[name="documentVersionId"]').selectOption(item.documentVersionId); await review.locator('[name="agentVersionReference"]').fill('SYNTHETIC_VERSION'); }
        else await review.locator('[name="decision"]').selectOption('NOT_APPLICABLE');
      }
      await review.locator('[name="reference"]').fill('SYNTHETIC_' + stage);
      await review.locator('[name="note"]').fill('Giudizio sintetico motivato sulla versione esatta; nessuna attività reale.');
      await review.getByRole('button').click(); await expect(page).toHaveURL(/dossierError=RECORDED/);
    }
    await admin.goto(target);
    const approval = admin.locator('form').filter({ has: admin.locator('button[name="decision"][value="APPROVED"]') });
    await approval.locator('textarea[name="note"]').fill('Versione sintetica esatta approvata.');
    await approval.getByRole('button', { name: 'Approva questa versione' }).click();
    await expect.poll(async () => (await db.clientDossier.findUniqueOrThrow({ where: { id: item.dossierId } })).approvedVersionId).not.toBeNull();
    const exportsBeforeNavigation = await db.engagementDossierExport.count({ where: { dossierId: item.dossierId } });
    await operator.reload();
    const exportLink = operator.getByRole('link', { name: 'Esporta approvato .docx', exact: true });
    await expect(exportLink).toHaveAttribute('download', '');
    await operator.waitForLoadState('networkidle');
    expect(await db.engagementDossierExport.count({ where: { dossierId: item.dossierId } })).toBe(exportsBeforeNavigation);
    const [download] = await Promise.all([operator.waitForEvent('download', { timeout: 30_000 }), exportLink.click()]);
    expect(await download.failure()).toBeNull();
    expect(await db.engagementDossierExport.count({ where: { dossierId: item.dossierId } })).toBe(exportsBeforeNavigation + 1);
    const bytes = readFileSync((await download.path())!);
    const decoded = JSON.parse(execFileSync('python3', ['-I','-S','-c','import sys,io,zipfile,hashlib,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps({"logo":hashlib.sha256(z.read("word/media/logo-fai.png")).hexdigest(),"text":z.read("word/document.xml").decode()}))'], { input: bytes, encoding: 'utf8' }));
    expect(decoded.logo).toBe(INITIAL_SERVICE_LOGO_SHA256); expect(decoded.text).toContain(INITIAL_SERVICES[item.code].title); expect(decoded.text).toContain('Non eroghiamo finanziamenti.');
    const authorization = admin.locator('form').filter({ has: admin.locator('[name="recipientAddress"]') });
    await authorization.locator('[name="recipientName"]').fill('Cliente sintetico');
    await authorization.locator('[name="recipientAddress"]').fill('synthetic@invalid.test');
    await authorization.locator('[name="recipientSynthetic"]').check();
    await submit(admin, authorization.getByRole('button', { name: 'Autorizza consegna manuale' }));
    await expect.poll(async () => db.engagementDossierDeliveryAuthorization.count({ where: { dossierId: item.dossierId } })).toBe(1);
    await operator.reload();
    const delivery = operator.locator('form').filter({ has: operator.locator('[name="evidenceSynthetic"]') });
    await delivery.locator('[name="reference"]').fill('SYNTHETIC_BROWSER_RECEIPT');
    await delivery.locator('[name="deliveredAtLocal"]').fill('2026-09-27T12:00');
    await expect(delivery.locator('[name="deliveredAt"]')).toHaveValue('2026-09-27T10:00:00.000Z');
    await delivery.locator('[name="evidenceSynthetic"]').check();
    await submit(operator, delivery.getByRole('button', { name: 'Registra esito manuale' }));
    await expect.poll(async () => db.engagementDossierDeliveryReceipt.count({ where: { authorization: { dossierId: item.dossierId } } })).toBe(1);
    const receipt = await db.engagementDossierDeliveryReceipt.findFirstOrThrow({ where: { authorization: { dossierId: item.dossierId } } });
    expect((receipt.evidence as { deliveredAt: string }).deliveredAt).toBe('2026-09-27T10:00:00.000Z');
    evidence.push({ code: item.code, dossierId: item.dossierId, archiveHash: createHash('sha256').update(bytes).digest('hex'), logoHash: decoded.logo });
    console.log('M5_SYNTHETIC_BROWSER_SERVICE_PASS ' + item.code);
  }
  writeFileSync(join(root, 'browser-proof.json'), JSON.stringify({ synthetic: true, cases: evidence, realDelivery: false }, null, 2));
  await ac.close(); await oc.close(); await hc.close();
});
