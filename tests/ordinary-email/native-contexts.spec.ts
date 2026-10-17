import { test, expect, type Page, type Locator } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeEmailFixture } from './ui-fixture';

const db=new PrismaClient(),origin='http://127.0.0.1:3036',evidence=process.env.ORDINARY_EMAIL_BROWSER_EVIDENCE!;
test.afterAll(async()=>db.$disconnect());
async function login(page:Page,email:string) {
  await page.goto('/login');await page.locator('[data-interactive-ready="true"]').waitFor({state:'attached'});
  await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(process.env.ORDINARY_EMAIL_BROWSER_PASSWORD!);
  await page.getByRole('button',{name:'Login interno'}).click();await expect(page).toHaveURL(/\/dashboard$/);
}
async function draft(form:Locator,mailboxId:string,address:string,subject:string) {
  await form.locator('select[name="mailboxId"]').selectOption(mailboxId);await form.locator('[name="replyTo"]').fill(address);
  await form.getByLabel('Oggetto',{exact:true}).fill(subject);await form.getByLabel('Testo esatto',{exact:true}).fill('SYNTHETIC_CONTEXT_NATIVE_BODY');
}
test('native lead, standalone client and internal composition preserve context, private files and live participant revocation',async({browser})=>{
  const f=await nativeEmailFixture(db);
  const member=await db.user.create({data:{name:'Synthetic internal member',email:'member-'+randomUUID()+'@invalid.test',role:'commerciale',active:true,passwordHash:f.user.passwordHash}});
  const lead=await db.lead.create({data:{firstName:'Native',lastName:'Synthetic context lead',email:'lead-native@invalid.test'}});
  const counts={clients:await db.client.count(),practices:await db.technicalPractice.count(),documents:await db.document.count()};
  const contexts=await Promise.all([browser.newContext({viewport:{width:1280,height:900}}),browser.newContext(),browser.newContext()]);
  let external=0;
  for(const context of contexts)await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin!==origin){external++;return route.abort();}return route.continue();
  });
  const [page,participant,outsider]=await Promise.all(contexts.map(c=>c.newPage()));
  await login(page,f.user.email);await login(participant,member.email);await login(outsider,f.other.email);
  const freshDraft=()=>page.locator('form').filter({has:page.locator('input[name="intent"][value="draft"]')}).filter({has:page.locator('input[name="expectedRevision"][value="0"]')});
  await page.goto('/leads/'+lead.id);await page.getByRole('link',{name:'Scrivi email',exact:true}).click();
  await expect(page).toHaveURL(new RegExp('kind=LEAD&practice='+lead.id));
  const leadForm=freshDraft();await expect(leadForm.locator('select[name="mailboxId"]')).toHaveValue('');await expect(leadForm.locator('input[name="to"]')).toHaveValue('');
  await leadForm.getByRole('button',{name:/Aggiungi in A il contatto del contesto/}).click();
  await draft(leadForm,f.box.id,f.box.address,'Native lead message');
  const leadMessage=await leadForm.locator('input[name="messageId"]').inputValue();
  await leadForm.getByRole('button',{name:'Salva bozza',exact:true}).click();
  await expect.poll(()=>db.approvedCommunication.count({where:{id:leadMessage,leadId:lead.id,contextKind:'LEAD',clientId:null}})).toBe(1);
  await page.goto('/clients/'+f.client.id);await page.getByRole('link',{name:'Scrivi email',exact:true}).click();
  const clientForm=freshDraft();await draft(clientForm,f.box.id,f.box.address,'Native client message');await clientForm.locator('input[name="to"]').fill('client-native@invalid.test');
  const clientMessage=await clientForm.locator('input[name="messageId"]').inputValue();await clientForm.getByRole('button',{name:'Salva bozza',exact:true}).click();
  await expect.poll(()=>db.approvedCommunication.count({where:{id:clientMessage,contextKind:'CLIENT',clientId:f.client.id,technicalPracticeId:null,readinessId:null}})).toBe(1);

  await page.goto('/communications');await page.getByLabel('Titolo della comunicazione interna').fill('Native private conversation');
  await page.locator('input[name="participant"][value="'+member.id+'"]').check();
  await page.getByRole('button',{name:'Mostra riepilogo partecipanti'}).click();
  await expect(page.getByRole('button',{name:'Conferma partecipanti',exact:true})).toBeDisabled();
  await page.goto('/settings/security');await page.getByLabel('Password corrente').fill(process.env.ORDINARY_EMAIL_BROWSER_PASSWORD!);
  await page.getByRole('button',{name:'Conferma per cinque minuti'}).click();await expect(page).toHaveURL(/status=active/);
  await page.goto('/communications');await page.getByLabel('Titolo della comunicazione interna').fill('Native private conversation');
  await page.locator('input[name="participant"][value="'+member.id+'"]').check();await page.getByRole('button',{name:'Mostra riepilogo partecipanti'}).click();
  await page.getByLabel('Confermo queste persone e l’accesso indicato.').check();await page.getByRole('button',{name:'Conferma partecipanti',exact:true}).click();
  await expect(page).toHaveURL(/kind=INTERNAL&practice=/);
  const internalUrl=new URL(page.url()),threadId=internalUrl.searchParams.get('practice')!,target=internalUrl.pathname+internalUrl.search;
  await expect.poll(()=>db.internalCommunicationParticipant.count({where:{threadId,active:true}})).toBe(2);
  await page.locator('summary').filter({hasText:'Allegati del contesto'}).click();
  const bytes=Buffer.from('ONLY SYNTHETIC CONTEXT FILE'),sha256=createHash('sha256').update(bytes).digest('hex');
  await page.getByLabel('Allegato da caricare').setInputFiles({name:'native-context.txt',mimeType:'text/plain',buffer:bytes});
  await page.getByRole('button',{name:'Carica allegato nel contesto'}).click();
  await expect.poll(()=>db.communicationContextFile.count({where:{internalThreadId:threadId,revokedAt:null}})).toBe(1);
  const file=await db.communicationContextFile.findFirstOrThrow({where:{internalThreadId:threadId}});await page.reload();
  const internalForm=freshDraft();await draft(internalForm,f.box.id,f.box.address,'Native internal message');
  const recipients=internalForm.getByRole('region',{name:'Destinatari A',exact:true});
  await recipients.locator('summary').click();await recipients.getByLabel('Synthetic internal member · '+member.email,{exact:true}).check();
  await internalForm.locator('input[name="contextFileId"][value="'+file.id+'"]').check();
  const internalMessage=await internalForm.locator('input[name="messageId"]').inputValue();
  await internalForm.getByRole('button',{name:'Salva bozza',exact:true}).click();
  await expect.poll(()=>db.approvedCommunication.count({where:{id:internalMessage,internalThreadId:threadId,clientId:null}})).toBe(1);
  const snapshot=(await db.communicationVersion.findUniqueOrThrow({where:{messageId_revision:{messageId:internalMessage,revision:1}}})).snapshot as {schema:string;to:string[];attachments:Array<{source:string;sha256:string}>};
  expect(snapshot.schema).toBe('fai.approved-email.v2');expect(snapshot.to).toEqual([member.email]);expect(snapshot.attachments).toMatchObject([{source:'CONTEXT_FILE',sha256}]);
  await expect(page.getByRole('heading',{name:'Native internal message · v1',exact:true})).toBeVisible();
  await page.locator('[data-ordinary-ready="true"]').first().waitFor({state:'attached'});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(evidence,'native-context-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:path.join(evidence,'native-context-mobile.png'),fullPage:true});await page.setViewportSize({width:1280,height:900});
  await participant.goto(target);await expect(participant.getByText('SYNTHETIC_CONTEXT_NATIVE_BODY',{exact:true})).toBeVisible();
  expect((await outsider.request.get(target)).status()).toBe(404);
  const download=()=>participant.request.post('/communications/files/'+file.id,{headers:{origin},form:{kind:'INTERNAL',contextId:threadId,sha256}});
  const downloaded=await download();expect(downloaded.status()).toBe(200);expect(await downloaded.body()).toEqual(bytes);
  expect((await outsider.request.post('/communications/files/'+file.id,{headers:{origin},form:{kind:'INTERNAL',contextId:threadId,sha256}})).status()).toBe(404);
  await page.locator('summary').filter({hasText:'Gestisci partecipanti della conversazione interna'}).click();
  await page.locator('input[name="participant"][value="'+member.id+'"]').uncheck();await page.getByRole('button',{name:'Mostra riepilogo partecipanti'}).click();
  await page.getByLabel('Confermo queste persone e l’accesso indicato.').check();await page.getByRole('button',{name:'Conferma partecipanti',exact:true}).click();
  await expect.poll(()=>db.internalCommunicationParticipant.count({where:{threadId,userId:member.id,active:true}})).toBe(0);
  expect((await participant.request.get(target)).status()).toBe(404);expect((await download()).status()).toBe(404);
  expect(await db.internalSession.count({where:{userId:member.id,revokedAt:null}})).toBeGreaterThan(0);
  await page.reload();await page.locator('[data-ordinary-ready="true"]').first().waitFor({state:'attached'});
  const review=page.locator('[data-ordinary-ready]').filter({has:page.locator('form[data-message-draft="'+internalMessage+'"]')});
  await review.getByRole('button',{name:'Anteprima email ordinaria'}).click();await expect(review).toContainText('non più disponibili');

  await page.goto('/communications');await page.getByLabel('Titolo della comunicazione interna').fill('Native lost response conversation');
  await page.locator('input[name="participant"][value="'+member.id+'"]').check();await page.getByRole('button',{name:'Mostra riepilogo partecipanti'}).click();
  let posts=0,captured:{body:string;headers:Record<string,string>}|undefined;
  await page.route('**/communications',async route=>{
    const request=route.request();if(request.method()==='POST'&&request.postData()?.includes('Native lost response conversation')){
      posts++;captured={body:request.postData()!,headers:{'next-action':request.headers()['next-action'],'content-type':request.headers()['content-type'],origin}};
      await route.fetch();await route.abort('failed');
    }else await route.fallback();
  });
  await page.getByLabel('Confermo queste persone e l’accesso indicato.').check();
  await page.getByRole('button',{name:'Conferma partecipanti',exact:true}).evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
  await expect.poll(()=>db.internalCommunicationThread.count({where:{title:'Native lost response conversation',ownerUserId:f.user.id}})).toBe(1);
  await expect(page.getByRole('status')).toContainText('Risposta non ricevuta');expect(posts).toBe(1);expect(captured).toBeTruthy();
  await expect(page.getByRole('button',{name:'Conferma partecipanti',exact:true})).toBeDisabled();await page.unroute('**/communications');
  const replay=await page.request.post('/communications',{headers:captured!.headers,data:captured!.body});expect(await replay.text()).toContain('CHECK_CURRENT');
  expect(await db.internalCommunicationThread.count({where:{title:'Native lost response conversation',ownerUserId:f.user.id}})).toBe(1);
  expect({clients:await db.client.count(),practices:await db.technicalPractice.count(),documents:await db.document.count()}).toEqual(counts);
  expect(await db.ordinaryEmailAttempt.count({where:{messageId:{in:[leadMessage,clientMessage,internalMessage]}}})).toBe(0);expect(external).toBe(0);
  await writeFile(path.join(evidence,'native-context-proof.json'),JSON.stringify({synthetic:true,nativeActions:true,leadClientInternal:true,explicitRecipients:true,
    privateUploadDownload:true,otherAdminDenied:true,participantOpenSessionRevocation:true,previousVersionInvalidated:true,stepUp:true,doubleClickPosts:posts,
    committedResponseLost:true,replayDenied:true,noPlaceholderClientOrPractice:true,realTransports:0,screenshotsInspected:false},null,2));
  for(const context of contexts)await context.close();
});
