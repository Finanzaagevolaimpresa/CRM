import { captureManual } from '../manuals-r23/capture';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), root = process.env.M4_BROWSER_EVIDENCE!, password = process.env.M4_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
async function login(page: Page, role: 'admin' | 'operator') {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(`m4-browser-${role}@invalid.test`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
test.afterAll(async () => { await db.$disconnect(); });
async function submit(page: Page, button: Locator) {
  const [response] = await Promise.all([page.waitForResponse(response => response.request().method() === 'POST' && Boolean(response.request().headers()['next-action'])), button.click()]);
  await response.finished(); expect(response.status()).toBeLessThan(400);
}
test('M4 real browser qualifies a manual mailbox, exact approval, actual bundle, uncertain reconciliation and received reply', async ({ browser }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(f.synthetic).toBe(true); expect(process.env.M4_BROWSER_CONFIRMED).toBe('1');
  const ac = await browser.newContext({ baseURL: 'http://127.0.0.1:3024' }), oc = await browser.newContext({ baseURL: 'http://127.0.0.1:3024' });
  const admin = await ac.newPage(), operator = await oc.newPage(), target = `/communications?kind=TECHNICAL&practice=${f.practiceId}`;
  await login(admin, 'admin'); await login(operator, 'operator');
  await admin.goto('/settings/security'); await admin.getByLabel('Password corrente').fill(password);
  await admin.getByRole('button', { name: 'Conferma per cinque minuti' }).click(); await expect(admin).toHaveURL(/status=active/);
  await admin.goto('/settings/communications');
  const box = admin.locator('form').filter({ has: admin.locator(`input[name="mailboxId"][value="${f.mailboxId}"]`) });
  const configure = box.filter({ has: admin.locator('input[name="intent"][value="configure"]') });
  await configure.locator('..').locator('summary').click();
  await configure.getByLabel('Riferimento pubblico del provider').fill('SYNTHETIC_BROWSER_PROVIDER');
  await configure.getByLabel('Responsabile', { exact: false }).selectOption(f.adminId);
  await configure.getByLabel('Riferimento della configurazione verificata').fill('SYNTHETIC_BROWSER_CONFIG');
  await configure.getByLabel('Invio esterno manuale disponibile').check(); await configure.getByLabel('Ricezione disponibile').check();
  await configure.getByRole('button', { name: 'Registra configurazione' }).click(); await expect(admin).toHaveURL(/result=RECORDED/);
  const testForm = box.filter({ has: admin.locator('input[name="intent"][value="TEST"]') });
  await testForm.getByLabel('Riferimento del collaudo invio e ricezione già eseguito').fill('SYNTHETIC_BROWSER_ROUNDTRIP');
  await testForm.getByRole('button', { name: 'Registra prova esterna' }).click();
  await expect.poll(async () => (await db.communicationMailbox.findUniqueOrThrow({ where: { id: f.mailboxId } })).testedRevision).toBe(2);
  await submit(admin, box.filter({ has: admin.locator('input[name="intent"][value="ENABLE"]') }).getByRole('button'));
  await expect.poll(async () => (await db.communicationMailbox.findUniqueOrThrow({ where: { id: f.mailboxId } })).enabled).toBe(true);
  await operator.goto(target);
  const draft = operator.locator('form').filter({ has: operator.locator('input[name="intent"][value="draft"]') });
  await draft.getByLabel('Mittente', { exact: false }).selectOption(f.mailboxId); await draft.getByLabel('Reply-To', { exact: true }).fill('assistenza@finanzaagevolaimpresa.it');
  await draft.getByLabel('A · indirizzi separati da virgola').fill('client@invalid.test'); await draft.getByLabel('BCC esplicita').fill('archive@invalid.test');
  await draft.getByLabel('Oggetto', { exact: true }).fill('M4 synthetic approved email'); await draft.getByLabel('Testo esatto').fill('Synthetic exact body; no real delivery.');
  await draft.locator(`input[name="attachmentVersionId"][value="${f.versionId}"]`).check(); await draft.getByRole('button', { name: 'Salva bozza', exact: true }).click();
  await expect(operator).toHaveURL(/result=RECORDED/);
  const message = await db.approvedCommunication.findFirstOrThrow({ where: { technicalPracticeId: f.practiceId } });
  await submit(operator, operator.getByRole('button', { name: 'Richiedi approvazione admin' }));
  await expect.poll(async () => (await db.approvedCommunication.findUniqueOrThrow({ where: { id: message.id } })).state).toBe('PENDING');
  await admin.goto(target); await expect(admin).toHaveURL(/\/communications\?kind=TECHNICAL/);
  await expect(admin.getByText('In approvazione', { exact: true })).toBeVisible();
  await captureManual(admin, 'S07-versione-esatta', 'admin', 'Messaggio sintetico in approvazione con destinatari, testo e allegato della versione esatta.');
  await admin.getByLabel('Approvo questo messaggio esatto', { exact: false }).check();
  await admin.getByRole('button', { name: 'Approva versione 1', exact: true }).click();
  await expect.poll(async () => (await db.approvedCommunication.findUniqueOrThrow({ where: { id: message.id } })).state).toBe('APPROVED');
  await operator.reload();
  const [download] = await Promise.all([operator.waitForEvent('download'), operator.getByRole('button', { name: 'Prepara invio manuale e scarica' }).click()]);
  const file = await download.path(); expect(file).toBeTruthy();
  const archiveHash = createHash('sha256').update(readFileSync(file!)).digest('hex');
  const decoded = JSON.parse(execFileSync('python3', ['-I', '-S', '-c',
    'import sys,io,zipfile,json,hashlib; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; m=json.loads(z.read("messaggio-approvato.json")); print(json.dumps({"protocol":m["protocol"],"bcc":m["message"]["bcc"],"material":hashlib.sha256(z.read("allegati/1/m4-synthetic.txt")).hexdigest()}))'],
  { input: readFileSync(file!), encoding: 'utf8' }));
  expect(decoded).toEqual({ protocol: 'FAI_APPROVED_MANUAL_EMAIL_V1', bcc: ['archive@invalid.test'], material: f.documentHash });
  const attempt = await db.communicationAttempt.findFirstOrThrow({ where: { messageId: message.id } }); expect(attempt.artifactHash).toBe(archiveHash);
  await expect(operator.getByRole('heading', { name: 'Registra l’esito manuale' })).toBeVisible();
  await captureManual(operator, 'S07-pacchetto-esito', 'consulente', 'Pacchetto realmente scaricato nel banco; esito esterno ancora da dichiarare. Nessuna email inviata.', operator.getByRole('heading', { name: 'Registra l’esito manuale' }));
  const evidence = operator.locator('form').filter({ has: operator.locator('input[name="intent"][value="evidence"]') });
  await evidence.getByLabel('Riferimento della ricevuta esterna').fill('SYNTHETIC_UNCERTAIN'); await evidence.getByRole('button', { name: 'Registra dichiarazione' }).click();
  await expect.poll(async () => (await db.approvedCommunication.findUniqueOrThrow({ where: { id: message.id } })).state).toBe('UNCERTAIN');
  await expect(operator.getByRole('button', { name: 'Prepara invio manuale e scarica' })).toHaveCount(0);
  await admin.reload();
  const reconciliation = admin.locator('form').filter({ has: admin.locator('input[name="intent"][value="evidence"]') });
  await reconciliation.getByLabel('Esito', { exact: false }).selectOption('SENT');
  await reconciliation.getByLabel('Riferimento della ricevuta esterna').fill('SYNTHETIC_MANUAL_SEND_ATTESTATION');
  await reconciliation.getByRole('button', { name: 'Registra dichiarazione' }).click();
  await expect.poll(async () => (await db.approvedCommunication.findUniqueOrThrow({ where: { id: message.id } })).state).toBe('SENT');
  await admin.goto('/settings/communications');
  const incoming = admin.locator('form').filter({ has: admin.locator('input[name="intent"][value="reply"]') });
  await incoming.getByLabel('Casella', { exact: false }).selectOption(f.mailboxId); await incoming.getByLabel('Message-ID del messaggio ricevuto').fill('<m4-browser-reply@invalid.test>');
  await incoming.getByLabel('In-Reply-To · se presente').fill(`<fai-${message.id}-v1@crm.finanzaagevolaimpresa.it>`);
  await incoming.getByLabel('Da', { exact: true }).fill('client@invalid.test'); await incoming.getByLabel('Oggetto', { exact: true }).fill('M4 synthetic reply');
  await incoming.getByLabel('Testo', { exact: true }).fill('Synthetic acquired response'); await incoming.getByLabel('Riferimento della prova').fill('SYNTHETIC_RECEIVE_ATTESTATION');
  await incoming.getByRole('button', { name: 'Acquisisci risposta' }).click();
  await expect.poll(async () => db.communicationReply.count({ where: { messageId: message.id } })).toBe(1);
  await operator.reload(); await expect(operator.getByText('Synthetic acquired response', { exact: true })).toBeVisible();
  await captureManual(operator, 'S07-risposta-sintetica', 'consulente', 'Dichiarazioni e risposta sintetiche collegate al messaggio; nessun provider reale contattato.', operator.getByText('Synthetic acquired response', { exact: true }));
  const before = await db.communicationAttempt.count({ where: { messageId: message.id } });
  await db.user.update({ where: { id: f.operatorId }, data: { active: false } }); await operator.reload(); await expect(operator).toHaveURL(/\/login/);
  expect(await db.communicationAttempt.count({ where: { messageId: message.id } })).toBe(before);
  writeFileSync(join(root, 'browser-proof.json'), JSON.stringify({ protocol: 'M4_CHROMIUM_MANUAL_EMAIL', synthetic: true, mailboxUiQualified: true,
    exactAdminApproval: true, actualDownloadedHash: archiveHash, uncertainReconciled: true, linkedReplyVisible: true, revokedAccessDenied: true,
    realProviderContact: false, realEmailSent: false, outcomeEvidence: 'SYNTHETIC_MANUAL_DECLARATION' }));
  await ac.close(); await oc.close();
});
