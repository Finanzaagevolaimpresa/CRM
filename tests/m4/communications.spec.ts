import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { readinessCommunicationFixture } from './readiness-fixture';
const db = new PrismaClient(), root = process.env.M4_BROWSER_EVIDENCE!, password = process.env.M4_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
async function login(page: Page, role: 'admin' | 'operator' | 'client-owner' | 'lead-owner') {
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
  const before = await db.communicationAttempt.count({ where: { messageId: message.id } });
  await db.user.update({ where: { id: f.operatorId }, data: { active: false } }); await operator.reload(); await expect(operator).toHaveURL(/\/login/);
  expect(await db.communicationAttempt.count({ where: { messageId: message.id } })).toBe(before);
  writeFileSync(join(root, 'browser-proof.json'), JSON.stringify({ protocol: 'M4_CHROMIUM_MANUAL_EMAIL', synthetic: true, mailboxUiQualified: true,
    exactAdminApproval: true, actualDownloadedHash: archiveHash, uncertainReconciled: true, linkedReplyVisible: true, revokedAccessDenied: true,
    realProviderContact: false, realEmailSent: false, outcomeEvidence: 'SYNTHETIC_MANUAL_DECLARATION' }));
  await ac.close(); await oc.close();
});

test('M4 readiness direct URLs and draft submissions follow the current originating lead assignment', async ({ browser }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(process.env.M4_BROWSER_CONFIRMED).toBe('1');
  const passwordHash = (await db.user.findUniqueOrThrow({ where: { id: f.adminId } })).passwordHash;
  const a = await db.user.create({ data: { email: 'm4-browser-client-owner@invalid.test', name: 'Synthetic client owner', role: 'consulente', passwordHash, active: true } });
  const b = await db.user.create({ data: { email: 'm4-browser-lead-owner@invalid.test', name: 'Synthetic lead owner', role: 'consulente', passwordHash, active: true } });
  const r = await readinessCommunicationFixture(db, a.id, b.id), target = `/communications?kind=READINESS&practice=${r.practice.id}`;
  expect(r.practice.projectId).toBeNull(); expect(r.practice.clientServiceId).toBeNull();
  const own = await db.technicalPractice.create({ data: { clientId: r.client.id, title: 'Synthetic own context', practiceType: 'test',
    targetEntity: 'Synthetic', technicalOwnerId: a.id, createdById: f.adminId } });
  const ac = await browser.newContext(), bc = await browser.newContext(), ap = await ac.newPage(), bp = await bc.newPage();
  await login(ap, 'client-owner'); await login(bp, 'lead-owner');
  const subject = 'M4_PRIVATE_READINESS_SUBJECT', body = 'M4_PRIVATE_READINESS_BODY', recipient = 'private-readiness@invalid.test';
  async function fill(draft: Locator) {
    await draft.getByLabel('Mittente', { exact: false }).selectOption(f.mailboxId);
    await draft.getByLabel('Reply-To', { exact: true }).fill('assistenza@finanzaagevolaimpresa.it');
    await draft.getByLabel('A · indirizzi separati da virgola').fill(recipient);
    await draft.getByLabel('Oggetto', { exact: true }).fill(subject); await draft.getByLabel('Testo esatto').fill(body);
  }
  const draft = (page: Page) => page.locator('form').filter({ has: page.locator('input[name="intent"][value="draft"]') }).first();
  await bp.goto(target); await fill(draft(bp)); await submit(bp, draft(bp).getByRole('button', { name: 'Salva bozza', exact: true }));
  await expect(bp).toHaveURL(/result=RECORDED/); await expect(bp.locator('div.whitespace-pre-wrap').filter({ hasText: body })).toBeVisible();
  const message = await db.approvedCommunication.findFirstOrThrow({ where: { readinessId: r.practice.id } });
  const footprint = async () => ({ messages: await db.approvedCommunication.count({ where: { readinessId: r.practice.id } }),
    versions: await db.communicationVersion.count({ where: { messageId: message.id } }),
    events: await db.communicationEvent.count({ where: { messageId: message.id } }),
    audits: await db.auditLog.count({ where: { entityId: message.id } }) });
  const before = await footprint();
  const denied = await ap.goto(target), deniedHtml = await denied!.text();
  for (const marker of [subject, body, recipient, message.id]) expect(deniedHtml).not.toContain(marker);
  await expect(ap.getByRole('heading', { name: '404', exact: true })).toBeVisible();
  await expect(ap.locator('input[name="intent"][value="draft"]')).toHaveCount(0);
  // A has a genuine permitted form, but replacing its target must not grant access to B's message.
  await ap.goto(`/communications?kind=TECHNICAL&practice=${own.id}`); await fill(draft(ap));
  for (const [name, value] of Object.entries({ contextKind: 'READINESS', contextId: r.practice.id, messageId: message.id, expectedRevision: '1' }))
    await draft(ap).locator(`input[name="${name}"]`).evaluate((node: HTMLInputElement, next: string) => { node.value = next; }, value);
  await submit(ap, draft(ap).getByRole('button', { name: 'Salva bozza', exact: true })); await expect(ap).toHaveURL(/result=DENIED/);
  expect(await footprint()).toEqual(before);
  // B's already rendered form loses authority as soon as the lead changes hands.
  await fill(draft(bp));
  await db.lead.update({ where: { id: r.lead.id }, data: { assignedToId: a.id } });
  await submit(bp, draft(bp).getByRole('button', { name: 'Salva bozza', exact: true })); await expect(bp).toHaveURL(/result=DENIED/);
  expect(await footprint()).toEqual(before);
  const revoked = await bp.goto(target), revokedHtml = await revoked!.text();
  for (const marker of [subject, body, recipient, message.id]) expect(revokedHtml).not.toContain(marker);
  await expect(bp.getByRole('heading', { name: '404', exact: true })).toBeVisible();
  await ap.goto(target); await expect(ap.locator('div.whitespace-pre-wrap').filter({ hasText: body })).toBeVisible();
  await ap.getByText('Modifica e invalida l’approvazione precedente', { exact: true }).click();
  await submit(ap, ap.getByRole('button', { name: 'Salva nuova versione da approvare', exact: true }));
  await expect(ap).toHaveURL(/result=RECORDED/);
  expect((await db.approvedCommunication.findUniqueOrThrow({ where: { id: message.id } })).currentRevision).toBe(2);
  writeFileSync(join(root, 'readiness-isolation-proof.json'), JSON.stringify({ synthetic: true, directUrlClientOwnerDenied: true,
    crossContextSaveDeniedWithoutMutation: true, leadOwnerReadAndSaveAllowed: true, reassignmentRevokesStaleForm: true,
    revokedDirectUrlContainsNoMessage: true, newLeadOwnerReadAndSaveAllowed: true, realEmailSent: false }));
  await ac.close(); await bc.close();
});
