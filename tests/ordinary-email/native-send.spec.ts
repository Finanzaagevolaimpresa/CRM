import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeEmailFixture, qualifyNativeTransport } from './ui-fixture';
import { tokenDigestFromCookie } from '../../src/lib/internal-session-registry';
import { saveApprovedMessageDraft } from '../../src/lib/approved-communications';
import { emptyCommunicationRecipientSelection } from '../../src/lib/communication-recipient-policy';
import { previewInternalCommunication, confirmInternalCommunication } from '../../src/lib/internal-communications';
import { createPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';
import { storeCommunicationFile } from '../../src/lib/communication-files';

const db = new PrismaClient(), origin = 'http://127.0.0.1:3036', evidence = process.env.ORDINARY_EMAIL_BROWSER_EVIDENCE!;
const confirmation = 'Approvo e invio personalmente questa versione esatta, inclusi mittente, destinatari, testo e allegati.';
type Captured = { body: string; headers: Record<string, string> };
type Metrics = { connections: number; authenticated: number; contents: Array<{ from: string; recipients: string[]; sha256: string; bccHeader: boolean; servername: string; protocol: string; mode: string }> };
const metrics = async (): Promise<Metrics> => JSON.parse(await readFile(path.join(evidence, 'synthetic-smtp.json'), 'utf8'));
test.afterAll(async () => db.$disconnect());
async function login(page: Page, email: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(process.env.ORDINARY_EMAIL_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function stepUp(page: Page) {
  await page.goto('/settings/security'); await page.getByLabel('Password corrente').fill(process.env.ORDINARY_EMAIL_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Conferma per cinque minuti' }).click(); await expect(page).toHaveURL(/status=active/);
}

test('native personal send uses isolated verified TLS, exact decisions and durable receipts without replay', async ({ browser }) => {
  const network = JSON.parse(await readFile(path.join(evidence, 'network-proof.json'), 'utf8'));
  const tlsProof = JSON.parse(await readFile(path.join(evidence, 'tls-boundary-proof.json'), 'utf8'));
  expect(network).toMatchObject({ ipv4DefaultRoute: false, canonicalSmtpResolvesToOwnInterface: true, applicationNetworks: 1 });
  expect(tlsProof).toMatchObject({ trusted: true, wrongServernameDenied: true, untrustedIssuerDenied: true });
  const f = await nativeEmailFixture(db);
  let target = '/communications?kind=TECHNICAL&practice=' + f.practice.id;
  await qualifyNativeTransport(db, f);
  const baseline = await metrics();
  expect(baseline.authenticated).toBe(0); expect(baseline.contents).toHaveLength(0);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherContext = await browser.newContext(), secondContext = await browser.newContext();
  let externalRequests = 0;
  for (const c of [context, otherContext, secondContext]) await c.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { externalRequests++; return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(), other = await otherContext.newPage(), second = await secondContext.newPage();
  await login(page, f.user.email); await login(other, f.other.email); await stepUp(other); await login(second, f.user.email);
  const panel = (id: string) => page.locator('[data-ordinary-ready]').filter({ has: page.locator('form[data-message-draft="' + id + '"]') })
    .getByRole('region', { name: 'Decisione personale email', exact: true });
  const exact = (id: string) => panel(id).getByRole('region', { name: 'Anteprima della versione esatta', exact: true });
  async function open(id: string) {
    await page.goto(target); await page.locator('[data-ordinary-ready="true"]').first().waitFor({ state: 'attached' });
    await panel(id).getByRole('button', { name: 'Anteprima email ordinaria' }).click();
    await expect(exact(id)).toBeVisible();
  }
  async function send(id: string) {
    await exact(id).getByLabel(confirmation, { exact: true }).check();
    await exact(id).getByRole('button', { name: 'Approva e invia', exact: true }).click();
  }
  const attempts = async (id: string) => (await db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::integer AS count FROM "OrdinaryEmailAttempt" WHERE "messageId"=${id}::uuid`)[0].count;
  const state = async (id: string) => (await db.approvedCommunication.findUniqueOrThrow({ where: { id } })).state;
  const receipt = async (id: string) => (await db.$queryRaw<Array<{ outcome: string; phase: string }>>`SELECT o."outcome",o."phase" FROM "OrdinaryEmailOutcome" o
    JOIN "OrdinaryEmailAttempt" a ON a."id"=o."attemptId" WHERE a."messageId"=${id}::uuid`)[0];
  async function fresh(subject: string) {
    return saveApprovedMessageDraft(db, f.actor, { ...f.input, messageId: randomUUID(), expectedRevision: 0, subject });
  }

  await open(f.saved.id);
  await expect(exact(f.saved.id).getByRole('button', { name: 'Approva e invia', exact: true })).toBeDisabled();
  await stepUp(page); await open(f.saved.id);
  await db.$executeRaw`UPDATE "OrdinaryEmailChannel" SET "revision"="revision"+1,"qualificationReference"='SYNTHETIC_CHANGED' WHERE "mailboxId"=${f.box.id}::uuid`;
  await send(f.saved.id); await expect(panel(f.saved.id)).toContainText('Esito da verificare');
  expect(await attempts(f.saved.id)).toBe(0); expect((await metrics()).connections).toBe(baseline.connections);
  await open(f.saved.id); await expect(exact(f.saved.id)).toContainText('Invio ordinario non disponibile');
  expect(await exact(f.saved.id).getByRole('button', { name: 'Approva e invia', exact: true }).count()).toBe(0);
  await qualifyNativeTransport(db, f);

  await open(f.saved.id); await second.goto(target);
  const editor = second.locator('form[data-message-draft="' + f.saved.id + '"]');
  await editor.locator('..').locator(':scope > summary').click(); await editor.getByLabel('Testo esatto').fill('NUOVA VERSIONE NATIVA DA INVIARE');
  await editor.getByRole('button', { name: 'Salva nuova versione da approvare' }).click();
  await expect.poll(async () => (await db.approvedCommunication.findUniqueOrThrow({ where: { id: f.saved.id } })).currentRevision).toBe(2);
  await send(f.saved.id); await expect(panel(f.saved.id)).toContainText('Esito da verificare');
  expect(await attempts(f.saved.id)).toBe(0); expect((await metrics()).connections).toBe(baseline.connections);

  await open(f.saved.id);
  const cookie = (await context.cookies()).find(value => value.name === process.env.AUTH_COOKIE_NAME)!;
  const digest = await tokenDigestFromCookie(cookie.value); expect(digest).toBeTruthy();
  await db.internalSession.updateMany({ where: { tokenDigest: Buffer.from(digest!) }, data: { revokedAt: new Date() } });
  await send(f.saved.id); await expect(page).toHaveURL(/\/login$/);
  expect(await attempts(f.saved.id)).toBe(0); expect((await metrics()).connections).toBe(baseline.connections);
  await login(page, f.user.email); await stepUp(page); await open(f.saved.id);
  await expect(exact(f.saved.id)).toContainText('NUOVA VERSIONE NATIVA DA INVIARE');
  await page.screenshot({ path: path.join(evidence, 'native-send-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await exact(f.saved.id).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(evidence, 'native-send-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  let sentRequest: Captured | undefined, posts = 0, otherAdminDenied = false;
  await page.route('**/communications?**', async route => {
    const request = route.request();
    if (request.method() === 'POST' && request.postData()?.includes('APPROVO_E_INVIO_IL_MESSAGGIO_ESATTO')) {
      posts++; sentRequest = { body: request.postData()!, headers: {
        'next-action': request.headers()['next-action'], 'content-type': request.headers()['content-type'], origin } };
      const denied = await other.request.post(target, { headers: sentRequest.headers, data: sentRequest.body });
      expect(await denied.text()).toContain('CHECK_CURRENT'); expect(await attempts(f.saved.id)).toBe(0);
      expect((await metrics()).connections).toBe(baseline.connections); otherAdminDenied = true;
      await route.fetch(); await route.abort('failed');
    } else await route.fallback();
  });
  await exact(f.saved.id).getByLabel(confirmation, { exact: true }).check();
  await exact(f.saved.id).getByRole('button', { name: 'Approva e invia', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => state(f.saved.id)).toBe('SENT');
  await expect(panel(f.saved.id)).toContainText('Risposta non ricevuta');
  expect(posts).toBe(1); expect(sentRequest).toBeTruthy(); expect(otherAdminDenied).toBe(true);
  await expect(panel(f.saved.id).getByRole('button', { name: 'Anteprima email ordinaria' })).toBeDisabled();
  await page.unroute('**/communications?**');
  const replay = await page.request.post(target, { headers: sentRequest!.headers, data: sentRequest!.body });
  expect(await replay.text()).toContain('CHECK_CURRENT'); expect(await attempts(f.saved.id)).toBe(1);
  expect(await receipt(f.saved.id)).toMatchObject({ outcome: 'ACCEPTED', phase: 'CONTENT' });
  await expect.poll(async () => (await metrics()).contents.length).toBe(1);
  const accepted = await metrics(), content = accepted.contents[0];
  expect(accepted.connections).toBe(baseline.connections + 1); expect(accepted.authenticated).toBe(1);
  expect(content).toMatchObject({ from: f.box.address, bccHeader: false, servername: 'authsmtp.securemail.pro', mode: 'accept' });
  expect(content.recipients).toEqual([...f.input.to, ...f.input.cc, ...f.input.bcc]);
  const [decision] = await db.$queryRaw<Array<{ decision: { mimeHash: string; draftRevision: number } }>>`SELECT d."decision" FROM "OrdinaryEmailDecision" d WHERE d."messageId"=${f.saved.id}::uuid`;
  expect(decision.decision.mimeHash).toBe(content.sha256); expect(decision.decision.draftRevision).toBe(2);
  expect(await db.auditLog.count({ where: { entityId: f.saved.id, event: { in: ['ordinary_email_reserved','ordinary_email_claimed','ordinary_email_outcome'] } } })).toBe(3);
  await page.reload(); await expect(page.getByText('Accettata dal server', { exact: true }).first()).toBeVisible();
  expect(await panel(f.saved.id).count()).toBe(0);
  await page.screenshot({ path: path.join(evidence, 'native-send-accepted-receipt.png'), fullPage: true });

  await writeFile(path.join(process.env.ORDINARY_EMAIL_TLS_CONTROL!, 'mode'), 'reject');
  const refused = await fresh('Rifiuto SMTP sintetico'); await open(refused.id); await send(refused.id);
  await expect.poll(() => state(refused.id)).toBe('ERROR');
  expect(await receipt(refused.id)).toMatchObject({ outcome: 'NOT_SENT', phase: 'RCPT' });
  expect((await metrics()).contents).toHaveLength(1);
  expect(await attempts(refused.id)).toBe(1);

  await writeFile(path.join(process.env.ORDINARY_EMAIL_TLS_CONTROL!, 'mode'), 'drop');
  const uncertain = await fresh('Esito SMTP incerto sintetico'); await open(uncertain.id); await send(uncertain.id);
  await expect.poll(() => state(uncertain.id)).toBe('UNCERTAIN');
  expect(await receipt(uncertain.id)).toMatchObject({ outcome: 'UNCERTAIN', phase: 'CONTENT' });
  await page.reload(); await expect(page.getByText('Esito incerto · non ripetere', { exact: true }).first()).toBeVisible();
  expect(await panel(uncertain.id).count()).toBe(0);
  expect(await attempts(uncertain.id)).toBe(1);

  // The same qualified adapter and native personal action serve all new contexts.
  // The server remains the isolated synthetic TLS peer; no new transport exists.
  await writeFile(path.join(process.env.ORDINARY_EMAIL_TLS_CONTROL!, 'mode'), 'accept');
  const member=await db.user.create({data:{name:'Synthetic context recipient',email:'tls-member-'+randomUUID()+'@invalid.test',role:'commerciale',active:true,passwordHash:f.user.passwordHash}});
  const lead=await db.lead.create({data:{firstName:'Synthetic',lastName:'TLS context',email:'tls-lead@invalid.test'}});
  const credentials={key:f.key,sessionToken:f.cookie,stepUpToken:createPrivilegedStepUpToken({key:f.key,userId:f.user.id,sessionToken:f.cookie})};
  const thread={id:randomUUID(),expectedVersion:0,title:'Synthetic TLS internal conversation',selection:{userIds:[member.id],groups:[]}};
  const participants=await previewInternalCommunication(db,f.actor,thread,credentials);
  await confirmInternalCommunication(db,f.actor,thread,participants.evidenceHash,credentials);
  const fileId=randomUUID(),fileContext={kind:'INTERNAL' as const,id:thread.id};
  await storeCommunicationFile(db,f.actor,{id:fileId,context:fileContext,classification:'ORDINARY'},new File([Buffer.from('SYNTHETIC_TLS_PRIVATE_ATTACHMENT')],'tls-context.txt',{type:'text/plain'}));
  for(const context of [{kind:'LEAD' as const,id:lead.id},{kind:'CLIENT' as const,id:f.client.id},fileContext]) {
    const selection=emptyCommunicationRecipientSelection();selection.to.userIds=[member.id];
    const contextual=await saveApprovedMessageDraft(db,f.actor,{...f.input,messageId:randomUUID(),expectedRevision:0,context,
      subject:'Synthetic TLS '+context.kind,to:[],cc:[],bcc:[],recipientSelection:selection,attachmentVersionIds:[],contextFileIds:context.kind==='INTERNAL'?[fileId]:[]});
    target='/communications?kind='+context.kind+'&practice='+context.id;
    const before=await metrics();await open(contextual.id);await send(contextual.id);await expect.poll(()=>state(contextual.id)).toBe('SENT');
    await expect.poll(async()=>(await metrics()).contents.length).toBe(before.contents.length+1);
    const delivered=(await metrics()).contents.at(-1)!;
    expect(delivered.recipients).toEqual([member.email]);expect(delivered).toMatchObject({from:f.box.address,bccHeader:false,servername:'authsmtp.securemail.pro',mode:'accept'});
    const [exactDecision]=await db.$queryRaw<Array<{decision:{mimeHash:string}}>>`SELECT "decision" FROM "OrdinaryEmailDecision" WHERE "messageId"=${contextual.id}::uuid`;
    expect(exactDecision.decision.mimeHash).toBe(delivered.sha256);expect(await attempts(contextual.id)).toBe(1);
    expect(await receipt(contextual.id)).toMatchObject({outcome:'ACCEPTED',phase:'CONTENT'});
  }
  target='/communications?kind=TECHNICAL&practice='+f.practice.id;
  const keyDenied = await fresh('Chiave ritirata sintetica'); await open(keyDenied.id);
  await db.applicationKeyVersion.updateMany({ where: { purpose: 'PRIVILEGED_STEP_UP', status: 'ACTIVE' }, data: { status: 'RETIRED', retiredAt: new Date() } });
  await send(keyDenied.id); await expect(page).toHaveURL(/\/settings\/security\?status=unavailable$/);
  expect(await attempts(keyDenied.id)).toBe(0);
  const last = await metrics();
  expect(last.connections).toBe(baseline.connections + 6); expect(last.authenticated).toBe(6); expect(last.contents).toHaveLength(5);
  expect(externalRequests).toBe(0);
  const proof = { synthetic: true, nativeLoginAndStepUp: true, nativeSendAction: true, nativeTls: true,
    internalNetwork: network.internalNetwork, noIpv4DefaultRoute: network.ipv4DefaultRoute === false,
    wrongServernameDenied: tlsProof.wrongServernameDenied, untrustedIssuerDenied: tlsProof.untrustedIssuerDenied,
    otherAdminDenied, concurrentEditDenied: true, changedQualificationDenied: true, currentSessionRevocationDenied: true,
    retiredKeyDenied: true, doubleClickPosts: posts, committedResponseLost: true, replayDenied: true,
    exactMimeHash: true, exactEnvelope: true, bccHeaderAbsent: true, accepted: 4, notSent: 1, uncertain: 1,
    leadClientInternalNativeTls: true, privateContextAttachment: true,
    authenticatedSyntheticConnections: last.authenticated, externalBrowserRequests: externalRequests, automaticRetries: 0, screenshotsInspected: false };
  await writeFile(path.join(evidence, 'native-send-proof.json'), JSON.stringify(proof, null, 2));
  console.log('ORDINARY_NATIVE_SEND_PROOF ' + JSON.stringify(proof));
  await context.close(); await otherContext.close(); await secondContext.close();
});
