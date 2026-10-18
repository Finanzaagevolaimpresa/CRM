import { readFileSync } from 'node:fs';
import { test,expect,type Page } from '@playwright/test';

test('packaged schema54 restart retains context messages, private files and revoked participants',async({browser})=>{
  const f=JSON.parse(readFileSync(process.env.R05_CONTEXT_RECOVERY_FIXTURE!,'utf8')) as {
    synthetic:boolean;persistenceOnly:boolean;threadId:string;deletedThreadId:string;ownerEmail:string;memberEmail:string;otherEmail:string;
    leadId:string;clientId:string;fileId:string;revokedFileId:string;sha256:string;bytes:string;
  };
  expect(f.synthetic&&f.persistenceOnly).toBe(true);
  const origin=process.env.PRACTICE_READINESS_BROWSER_ORIGIN!,contexts=await Promise.all([browser.newContext(),browser.newContext(),browser.newContext()]);
  const [owner,member,other]=await Promise.all(contexts.map(c=>c.newPage()));
  async function login(page:Page,email:string){
    await page.goto(origin+'/login');await page.locator('[data-interactive-ready="true"]').waitFor({state:'attached'});
    await page.getByLabel('Email').fill(email);await page.getByLabel('Password').fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
    await page.getByRole('button',{name:'Login interno'}).click();await expect(page).toHaveURL(origin+'/dashboard');
  }
  await login(owner,f.ownerEmail);await login(member,f.memberEmail);await login(other,f.otherEmail);
  const target=origin+'/communications?kind=INTERNAL&practice='+f.threadId;
  for(const page of [owner,member]){
    await page.goto(target);await expect(page.getByText('SYNTHETIC_CONTEXT_RETAINED_BODY',{exact:true})).toBeVisible();
    expect((await page.request.post(origin+'/communications/files/'+f.fileId,{headers:{origin},form:{kind:'INTERNAL',contextId:f.threadId,sha256:f.sha256}})).status()).toBe(200);
    expect((await page.request.post(origin+'/communications/files/'+f.revokedFileId,{headers:{origin},form:{kind:'INTERNAL',contextId:f.threadId,sha256:f.sha256}})).status()).toBe(404);
    expect((await page.request.get(origin+'/communications?kind=INTERNAL&practice='+f.deletedThreadId)).status()).toBe(404);
  }
  const bytes=await member.request.post(origin+'/communications/files/'+f.fileId,{headers:{origin},form:{kind:'INTERNAL',contextId:f.threadId,sha256:f.sha256}});
  expect(await bytes.body()).toEqual(Buffer.from(f.bytes));
  expect((await other.request.get(target)).status()).toBe(404);
  expect((await other.request.post(origin+'/communications/files/'+f.fileId,{headers:{origin},form:{kind:'INTERNAL',contextId:f.threadId,sha256:f.sha256}})).status()).toBe(404);
  for(const [kind,id] of [['LEAD',f.leadId],['CLIENT',f.clientId]]){
    await owner.goto(origin+'/communications?kind='+kind+'&practice='+id);await expect(owner.getByText('SYNTHETIC_CONTEXT_RETAINED_BODY',{exact:true})).toBeVisible();
    expect(await owner.getByRole('button',{name:'Salva bozza',exact:true}).count()).toBe(0);
  }
  for(const context of contexts)await context.close();
});
