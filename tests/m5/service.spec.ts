import { captureManual } from '../manuals-r23/capture';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { INITIAL_SERVICES, INITIAL_SERVICE_LOGO_SHA256, type InitialServiceCode } from '../../src/lib/initial-service-contract';
import bcrypt from 'bcryptjs';
import { syntheticCase, syntheticUser } from './fixtures';
import { proposePracticeOfferRevision } from '../../src/lib/practice-readiness';
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
  for (const item of f.cases as Array<{ code: InitialServiceCode; clientId: string; serviceId: string; dossierId: string; documentVersionId: string }>) {
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
    if (item === f.cases[0]) {
      await expect(configure.locator('[name="responsibleUserId"]')).toHaveValue(f.operatorId);
      await expect(configure.locator('[name="human1"]')).toHaveValue(f.human1Id);
      await captureManual(admin, 'S06-responsabilita', 'admin', 'Responsabile del servizio e revisore umano distinti, legati alla versione sintetica corrente.', configure, [configure.locator('[name="responsibleUserId"]'), configure.locator('[name="human1"]')]);
      await operator.goto(target);
      const workHeading = operator.getByRole('heading', { name: 'Lavorazione manuale con Work', exact: true });
      await expect(operator.getByRole('button', { name: 'Scarica pacchetto Work', exact: true })).toBeVisible();
      await captureManual(operator, 'S06-dossier-work', 'consulente', 'Percorso manuale Work della versione sintetica corrente: conferma dell’operatore e preparazione del pacchetto; nessuna sincronizzazione automatica.', workHeading, [operator.getByRole('button', { name: 'Scarica pacchetto Work', exact: true })]);
    }
    // Exercise the actual protected download route, not just the dossier page.
    const sourceVersion = await db.documentVersion.findUniqueOrThrow({ where: { id: item.documentVersionId } });
    const sourceDocument = await db.document.findUniqueOrThrow({ where: { id: sourceVersion.documentId } });
    const materialUrl = '/documents/' + sourceDocument.id + '/download';
    const material = await human.request.get(materialUrl);
    expect(material.status()).toBe(200);
    expect(createHash('sha256').update(await material.body()).digest('hex')).toBe(sourceVersion.checksum);
    expect((await human.request.get(materialUrl + '?versionId=unrelated-version')).status()).toBe(403);
    const unrelated = await db.document.create({ data: { clientId: sourceDocument.clientId, projectId: sourceDocument.projectId,
      type: sourceDocument.type, title: 'Unrelated material', fileName: sourceDocument.fileName, mimeType: sourceDocument.mimeType,
      sizeBytes: sourceDocument.sizeBytes, storagePath: sourceDocument.storagePath, checksum: sourceDocument.checksum, uploadedById: sourceDocument.uploadedById } });
    expect((await human.request.get('/documents/' + unrelated.id + '/download')).status()).toBe(403);
    await db.document.update({ where: { id: sourceDocument.id }, data: { containsSensitiveData: true } });
    await db.userPermissionOverride.upsert({ where: { userId_permission: { userId: f.human1Id, permission: 'document.sensitive.read' } }, create: { userId: f.human1Id, permission: 'document.sensitive.read', allowed: false }, update: { allowed: false } });
    expect((await human.request.get(materialUrl)).status()).toBe(403);
    await db.document.update({ where: { id: sourceDocument.id }, data: { containsSensitiveData: false } });
    const grantWhere = { userId: f.human1Id, clientId: sourceDocument.clientId! };
    await db.clientReadGrant.updateMany({ where: grantWhere, data: { active: false } });
    expect((await human.request.get(materialUrl)).status()).toBe(403);
    await db.clientReadGrant.updateMany({ where: grantWhere, data: { active: true } });
    expect((await human.request.get(materialUrl)).status()).toBe(200);
    const dossier = await db.clientDossier.findUniqueOrThrow({ where: { id: item.dossierId } });
    const report = await human.request.get('/clients/' + sourceDocument.clientId + '/operational-report');
    expect(report.status()).toBe(200); expect(await report.text()).toContain(dossier.title);
    for (const stage of ['A00','PRODUCER','Q01','Q02','Q03','HUMAN_1','D01']) {
      const page = stage === 'HUMAN_1' ? human : operator;
      await page.goto(target); const review = form(page, 'review');
      await expect(review.locator('[name="stage"]')).toHaveValue(stage);
      if (item === f.cases[0] && stage === 'HUMAN_1') await captureManual(human, 'S06-revisione-umana', 'revisore', 'Modulo personale del revisore sulla versione corrente, ancora da registrare: PASS selezionato non è una ricevuta del giudizio.', review);
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
    if (item === f.cases[0] && process.env.R23_MANUAL_EVIDENCE) {
      await operator.reload();
      await captureManual(operator, 'S08-consegna-manuale', 'consulente', 'Ricevuta manuale sintetica della versione autorizzata; non è un invio reale.', operator.getByRole('heading', { name: 'Consegne manuali tracciate', exact: true }));
      for (const role of ['sales', 'collaborator']) {
        const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3025' }), reader = await context.newPage();
        await login(reader, role); await reader.goto('/clients/' + item.clientId);
        await expect(reader.getByRole('heading', { name: 'Fascicolo Cliente Interno — Cliente sintetico M5', exact: true })).toBeVisible();
        await expect(reader.locator('#service-' + item.serviceId)).toBeVisible();
        await captureManual(reader, role === 'sales' ? 'S08-continuita-commerciale' : 'S08-consultazione-limitata',
          role === 'sales' ? 'commerciale' : 'collaboratore_limitato',
          'Dettaglio visibile dello stesso servizio sintetico con i permessi del profilo; la vista non attesta incasso, completamento o recapito della consegna.', reader.locator('#service-' + item.serviceId).getByRole('heading'));
        await context.close();
      }
    }
    evidence.push({ code: item.code, dossierId: item.dossierId, archiveHash: createHash('sha256').update(bytes).digest('hex'), logoHash: decoded.logo });
    console.log('M5_SYNTHETIC_BROWSER_SERVICE_PASS ' + item.code);
  }
  writeFileSync(join(root, 'browser-proof.json'), JSON.stringify({ synthetic: true, cases: evidence, realDelivery: false }, null, 2));
  await ac.close(); await oc.close(); await hc.close();
});

test('readiness hides sibling practices, funding, revisions and selector options on a shared client', async ({ browser }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const hash = await bcrypt.hash(password, 4);
  const a = await syntheticUser(db, 'consulente', 'Synthetic client owner', hash), b = await syntheticUser(db, 'consulente', 'Synthetic service owner', hash);
  const fixture = await syntheticCase(db, 'dossier_preanalisi', { operator: b, admin: await syntheticUser(db, 'admin', 'Synthetic admin'),
    human1: await syntheticUser(db, 'revisore', 'Synthetic reviewer one'), human2: await syntheticUser(db, 'revisore', 'Synthetic reviewer two') });
  const practice = await db.practiceReadiness.findUniqueOrThrow({ where: { id: fixture.practice.id } });
  const revision = await db.practiceOfferRevision.findUniqueOrThrow({ where: { id: practice.acceptedOfferRevisionId } });
  const scopeMarker = 'SIBLING_SCOPE_' + practice.id, startupMarker = 'SIBLING_STARTUP_' + practice.id;
  // Immutable accepted revision is not changed: use a separate proposed revision as the selector/content marker.
  const offer = await db.commercialOffer.findUniqueOrThrow({ where: { id: revision.commercialOfferId } });
  const proposal = await proposePracticeOfferRevision(db, b, { controlledIntakeId: practice.controlledIntakeId, commercialOfferId: offer.id,
    serviceRevisionId: revision.serviceRevisionId, clientId: fixture.client.id, projectId: fixture.project.id, scope: scopeMarker,
    startupConditions: startupMarker, requiredInitialAmount: revision.requiredInitialAmount.toFixed(2), expectedOfferUpdatedAt: offer.updatedAt });
  await db.client.update({ where: { id: fixture.client.id }, data: { consultantId: a.userId } });
  const ac = await browser.newContext(), bc = await browser.newContext(); const ap = await ac.newPage(), bp = await bc.newPage();
  for (const [page, actor] of [[ap, a], [bp, b]] as const) {
    const user = await db.user.findUniqueOrThrow({ where: { id: actor.userId } });
    await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
    await page.getByLabel('Email', { exact: true }).fill(user.email); await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  }
  const denied = await ap.goto('/practice-readiness'), allowed = await bp.goto('/practice-readiness');
  const deniedHtml = await denied!.text(), allowedHtml = await allowed!.text();
  for (const marker of [practice.id, proposal.id, practice.controlledIntakeId, revision.commercialOfferId, fixture.project.id, scopeMarker, startupMarker, 'SYNTHETIC_M5_PAYMENT'])
    expect(deniedHtml).not.toContain(marker);
  for (const marker of [practice.id, proposal.id, practice.controlledIntakeId, revision.commercialOfferId, fixture.project.id, scopeMarker, startupMarker]) expect(allowedHtml).toContain(marker);
  await db.clientService.update({ where: { id: fixture.service.id }, data: { assignedToId: a.userId } });
  // The separate proposal still belongs to B and deliberately mentions the practice ID in its synthetic text.
  // Check the actual practice row, not that unrelated text marker.
  expect(await (await bp.goto('/practice-readiness'))!.text()).not.toContain('id="practice-' + practice.id + '"');
  await expect(bp.locator('[id="practice-' + practice.id + '"]')).toHaveCount(0);
  expect(await (await ap.goto('/practice-readiness'))!.text()).toContain('id="practice-' + practice.id + '"');
  await expect(ap.locator('[id="practice-' + practice.id + '"]')).toHaveCount(1);
  await ac.close(); await bc.close();
});
