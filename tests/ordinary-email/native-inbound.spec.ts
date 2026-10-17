import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeInboundFixture } from './inbound-ui-fixture';
import { approvedMessageSnapshotSchema } from '../../src/lib/approved-communication-contract';
import { tokenDigestFromCookie } from '../../src/lib/internal-session-registry';

const db=new PrismaClient(), origin='http://127.0.0.1:3036', evidence=process.env.ORDINARY_EMAIL_BROWSER_EVIDENCE!;
test.afterAll(async()=>db.$disconnect());
async function login(page:Page,email:string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({state:'attached'});
  await page.getByLabel('Email',{exact:true}).fill(email); await page.getByLabel('Password',{exact:true}).fill(process.env.ORDINARY_EMAIL_BROWSER_PASSWORD!);
  await page.getByRole('button',{name:'Login interno'}).click(); await expect(page).toHaveURL(/\/dashboard$/);
}

test('native received reply becomes a separately approved draft with current scope and no automatic writes on GET',async({browser})=>{
  const f=await nativeInboundFixture(db), target=`/communications?kind=TECHNICAL&practice=${f.practice.id}`;
  const context=await browser.newContext({viewport:{width:1280,height:900}}), readerContext=await browser.newContext();
  let externalRequests=0;
  for(const c of [context,readerContext]) await c.route('**/*',route=>{
    if(new URL(route.request().url()).origin!==origin){externalRequests++;return route.abort();} return route.continue();
  });
  const page=await context.newPage(), reader=await readerContext.newPage();
  await login(page,f.user.email); await login(reader,f.other.email);
  const replies=()=>db.communicationReply.count({where:{messageId:f.saved.id}});
  await page.goto(target); await reader.goto(target); expect(await replies()).toBe(0);
  expect(await page.getByText(f.message.body,{exact:true}).count()).toBe(0);
  const intake=reader.locator(`[data-inbound-message="${f.saved.id}"]`);
  await expect(intake).toHaveAttribute('data-inbound-ready','true');
  let request:{body:string;headers:Record<string,string>}|undefined, posts=0;
  await reader.route('**/communications?**',async route=>{
    const req=route.request();
    if(req.method()==='POST'&&req.headers()['next-action']) {
      posts++; request={body:req.postData()!,headers:{'next-action':req.headers()['next-action'],'content-type':req.headers()['content-type'],origin}};
      const denied=await reader.request.post(target,{headers:{...request.headers,origin:'https://untrusted.invalid'},data:request.body});
      expect(await denied.text()).not.toContain('UPDATED'); expect(await replies()).toBe(0);
      await route.fetch(); await route.abort('failed');
    } else await route.fallback();
  });
  await intake.getByRole('button',{name:'Collega risposte ricevute'}).evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
  await expect.poll(replies).toBe(1); await expect(intake).toContainText('Risposta non ricevuta'); expect(posts).toBe(1);
  await reader.unroute('**/communications?**');
  await reader.reload(); await expect(reader.getByText(f.message.body,{exact:true})).toBeVisible();
  const linked=await db.communicationReply.findFirstOrThrow({where:{messageId:f.saved.id}});
  expect(linked.acquiredById).toBe(f.other.id); expect(linked.linkedById).toBe(f.other.id);
  expect(await reader.getByRole('region',{name:'Decisione personale email',exact:true}).count()).toBe(0);
  expect(await reader.locator('body').textContent()).not.toContain('UNASSOCIATED_PRIVATE_MARKER');
  expect(await reader.locator('body').textContent()).not.toContain('STRANGER_PRIVATE_MARKER');
  expect(await reader.evaluate(()=>('INBOUND_EXECUTED' in window))).toBe(false);
  const attachmentForm=reader.locator(`[data-linked-reply="${linked.id}"] section[aria-label="Allegati ricevuti"] form`);
  await expect(attachmentForm).toHaveCount(1);
  await expect(attachmentForm).toHaveAttribute('data-attachment-ready','true');
  const attachmentUrl=(await attachmentForm.getAttribute('action'))!;
  const attachmentData={payloadHash:(await attachmentForm.locator('[name="payloadHash"]').inputValue()),
    attachmentHash:(await attachmentForm.locator('[name="attachmentHash"]').inputValue())};
  const deniedDownload=await reader.request.post(attachmentUrl,{headers:{origin:'https://untrusted.invalid'},form:attachmentData});
  expect(deniedDownload.status()).toBe(404);
  const noGet=await reader.request.get(attachmentUrl); expect(noGet.status()).toBe(405);
  const downloaded=await reader.request.post(attachmentUrl,{headers:{origin},form:attachmentData});
  expect(downloaded.status()).toBe(200); expect(await downloaded.body()).toEqual(f.attachmentBytes);
  expect(downloaded.headers()['content-type']).toBe('application/octet-stream');
  expect(downloaded.headers()['x-content-type-options']).toBe('nosniff');
  expect(downloaded.headers()['cache-control']).toBe('private, no-store');
  expect(downloaded.headers()['content-security-policy']).toBe("sandbox; default-src 'none'");
  const actualDownload=reader.waitForEvent('download');
  await attachmentForm.getByRole('button',{name:'Scarica allegato 1',exact:true}).click();
  const download=await actualDownload; expect(download.suggestedFilename()).toBe('ricevuto-sintetico.txt');
  const chunks:Buffer[]=[]; for await(const chunk of (await download.createReadStream())!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(f.attachmentBytes);
  expect(await db.document.count({where:{clientId:f.client.id}})).toBe(1);
  const events=await db.communicationEvent.count({where:{messageId:f.saved.id,event:'ORDINARY_REPLY_LINKED'}});
  const replay=await reader.request.post(target,{headers:request!.headers,data:request!.body});
  expect(await replay.text()).toContain('UPDATED'); expect(await replies()).toBe(1);
  expect(await db.communicationEvent.count({where:{messageId:f.saved.id,event:'ORDINARY_REPLY_LINKED'}})).toBe(events);
  await db.selectiveProjectGrant.create({data:{projectId:f.project.id,recipientId:f.other.id,approvedById:f.user.id,
    revision:1,authorityRevision:1,keyVersion:f.key.version,selection:{},proof:'0'.repeat(64),approvedAt:new Date(),revokedAt:new Date()}});
  const scoped=await reader.request.post(target,{headers:request!.headers,data:request!.body}); expect(await scoped.text()).toContain('CHECK_CURRENT');
  await reader.reload(); expect(await reader.locator('body').textContent()).not.toContain(f.message.body);
  const staleDownload=await reader.request.post(attachmentUrl,{headers:{origin},form:attachmentData});
  expect(staleDownload.status()).toBe(404); expect(await staleDownload.text()).not.toContain(f.attachmentBytes.toString());

  await page.reload(); await page.locator(`[data-linked-reply="${linked.id}"]`).getByRole('link',{name:'Prepara risposta'}).click();
  const form=page.locator(`[data-reply-draft="${linked.id}"]`);
  for(const name of ['replyTo','to','cc','bcc','subject','body']) await expect(form.locator(`[name="${name}"]`)).toHaveValue('');
  await expect(form.locator('[name="mailboxId"]')).toHaveValue('');
  expect(await form.locator('input[name="attachmentVersionId"]:checked').count()).toBe(0);
  expect(await db.approvedCommunication.count({where:{technicalPracticeId:f.practice.id}})).toBe(1);
  await form.locator('select[name="mailboxId"]').selectOption(f.box.id); await form.getByLabel('Reply-To',{exact:true}).fill(f.box.address);
  await form.getByRole('region',{name:'Destinatari A',exact:true}).getByLabel('Indirizzi esterni · separati da virgola',{exact:true}).fill('explicit-reply@invalid.test');
  await form.getByLabel('Oggetto',{exact:true}).fill('Nuova risposta da valutare'); await form.getByLabel('Testo esatto',{exact:true}).fill('TESTO NUOVO SCRITTO ESPLICITAMENTE');
  const draftId=await form.locator('input[name="messageId"]').inputValue();
  await page.screenshot({path:path.join(evidence,'native-inbound-draft-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await form.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:path.join(evidence,'native-inbound-draft-mobile.png'),fullPage:true});
  await form.getByRole('button',{name:'Salva bozza',exact:true}).click(); await expect(page).toHaveURL(/result=RECORDED/);
  const version=await db.communicationVersion.findFirstOrThrow({where:{messageId:draftId},include:{approval:true}});
  const snapshot=approvedMessageSnapshotSchema.parse(version.snapshot);
  expect(snapshot.to).toEqual(['explicit-reply@invalid.test']); expect(snapshot.cc).toEqual([]); expect(snapshot.bcc).toEqual([]); expect(snapshot.attachments).toEqual([]);
  expect(snapshot.body).toBe('TESTO NUOVO SCRITTO ESPLICITAMENTE'); expect(version.approval).toBeNull();
  expect((await db.approvedCommunication.findUniqueOrThrow({where:{id:draftId}})).state).toBe('DRAFT');
  const panel=page.locator('[data-ordinary-ready]').filter({has:page.locator(`form[data-message-draft="${draftId}"]`)});
  await expect(panel).toHaveAttribute('data-ordinary-ready','true'); await panel.getByRole('button',{name:'Anteprima email ordinaria'}).click();
  await expect(panel.getByRole('button',{name:'Rifiuta versione 1'})).toBeDisabled();
  await page.goto('/settings/security'); await page.getByLabel('Password corrente').fill(process.env.ORDINARY_EMAIL_BROWSER_PASSWORD!);
  await page.getByRole('button',{name:'Conferma per cinque minuti'}).click(); await expect(page).toHaveURL(/status=active/);
  await page.goto(target); await expect(panel).toHaveAttribute('data-ordinary-ready','true');
  await panel.getByRole('button',{name:'Anteprima email ordinaria'}).click();
  await panel.getByLabel('Rifiuto personalmente questa versione esatta.').check(); await panel.getByRole('button',{name:'Rifiuta versione 1'}).click();
  await expect.poll(async()=>(await db.approvedCommunication.findUniqueOrThrow({where:{id:draftId}})).currentRevision).toBe(2);
  const [attempts]=await db.$queryRaw<Array<{count:number}>>`SELECT count(*)::integer AS count FROM "OrdinaryEmailAttempt" WHERE "messageId"=${draftId}::uuid`;
  expect(attempts.count).toBe(0);

  const sourceUrl=target+'&reply='+linked.id;
  await page.goto(sourceUrl); await expect(form).toBeVisible(); await f.conflict();
  await form.locator('select[name="mailboxId"]').selectOption(f.box.id); await form.getByLabel('Reply-To',{exact:true}).fill(f.box.address);
  await form.getByRole('region',{name:'Destinatari A',exact:true}).getByLabel('Indirizzi esterni · separati da virgola',{exact:true}).fill('explicit-reply@invalid.test');
  await form.getByLabel('Oggetto',{exact:true}).fill('Stale conflict'); await form.getByLabel('Testo esatto',{exact:true}).fill('STALE FORM MUST FAIL');
  await form.getByRole('button',{name:'Salva bozza',exact:true}).click(); await expect(page).toHaveURL(/result=DENIED/);
  expect(await db.approvedCommunication.count({where:{technicalPracticeId:f.practice.id}})).toBe(2);
  await page.goto(sourceUrl); await expect(form).toHaveCount(0); expect(await page.locator('body').textContent()).not.toContain(f.message.body);
  expect((await page.request.post(attachmentUrl,{headers:{origin},form:attachmentData})).status()).toBe(404);
  const cookie=(await readerContext.cookies()).find(item=>item.name===process.env.AUTH_COOKIE_NAME)!;
  const digest=await tokenDigestFromCookie(cookie.value);
  await db.internalSession.updateMany({where:{tokenDigest:Buffer.from(digest!)},data:{revokedAt:new Date()}});
  const revoked=await reader.request.post(target,{headers:request!.headers,data:request!.body}); expect(await revoked.text()).not.toContain('UPDATED');
  await db.project.update({where:{id:f.project.id},data:{status:'archiviato'}});
  const archived=await page.request.post(target,{headers:request!.headers,data:request!.body}); expect(await archived.text()).toContain('CHECK_CURRENT');
  await page.goto(target); expect(await page.locator('body').textContent()).not.toContain('TESTO NUOVO SCRITTO ESPLICITAMENTE');
  expect(externalRequests).toBe(0); expect(f.privateCalls()).toBe(2);
  const proof={synthetic:true,nativeLogin:true,readerWithoutStepUp:true,sourceAdaptersSimulated:true,receivedToDraftToPersonalRefusal:true,
    getWrites:0,otherContextsLeaked:0,untrustedMarkupExecuted:false,doubleClickPosts:posts,committedResponseLost:true,replayIdempotent:true,
    sourceConflictStaleFormDenied:true,selectiveScopeDenied:true,sessionRevocationDenied:true,archiveDenied:true,newDraftApprovals:0,newDraftAttempts:0,
    recipientsExplicit:true,attachmentsAutomaticallyCopied:0,receivedAttachmentDownloadVerified:true,receivedAttachmentImported:false,
    attachmentGetDisabled:true,attachmentOriginScopeConflictDenied:true,externalBrowserRequests:externalRequests,automaticRetries:0,screenshotsInspected:false};
  await writeFile(path.join(evidence,'native-inbound-proof.json'),JSON.stringify(proof,null,2));
  console.log('ORDINARY_NATIVE_INBOUND_PROOF '+JSON.stringify(proof));
  await context.close(); await readerContext.close();
});
