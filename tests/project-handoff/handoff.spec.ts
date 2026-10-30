import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db=new PrismaClient(), evidence=process.env.UPDATES_EVIDENCE!, password=process.env.UPDATES_BROWSER_PASSWORD!;
const f=JSON.parse(readFileSync(path.join(evidence,'fixture.json'),'utf8')) as {
  synthetic:boolean; adminId:string; readerId:string; commercialId:string; readerName:string; commercialName:string;
  emails:{admin:string;commercial:string}
};
async function login(page:Page,commercial=false) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({state:'attached'});
  await page.getByLabel('Email',{exact:true}).fill(commercial?f.emails.commercial:f.emails.admin);
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Login interno'}).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (!commercial) {
    await page.goto('/settings/security'); await page.getByLabel('Password corrente',{exact:true}).fill(password);
    await page.getByRole('button',{name:/Conferma per (5|30) minuti/,exact:true}).click();
    await expect(page.getByRole('button',{name:'Rimuovi conferma',exact:true})).toBeVisible();
  }
}
async function fixture() {
  const client=await db.client.create({data:{displayName:'Cliente handoff sintetico '+randomUUID(),type:'societa',salesOwnerId:f.commercialId}});
  const project=await db.project.create({data:{clientId:client.id,title:'Progetto handoff sintetico',consultantId:f.readerId}});
  return {client,project};
}
async function open(page:Page,id:string) {
  await page.goto(`/projects/${id}/technical-handoff`);
  await expect(page.getByTestId('project-handoff-form')).toHaveAttribute('data-interactive-ready','true');
}
async function preview(page:Page) {
  await expect(page.getByLabel('Referente commerciale',{exact:true})).toHaveValue(f.commercialId);
  await expect(page.getByLabel('Responsabile tecnico iniziale',{exact:true})).toHaveValue(f.readerId);
  await page.getByLabel('Tipologia pratica',{exact:true}).fill('Preparazione sintetica');
  await page.getByLabel('Ente destinatario o da definire',{exact:true}).fill('Da definire in progettazione');
  await page.getByRole('button',{name:'Controlla il passaggio',exact:true}).click();
  await expect(page.getByRole('region',{name:'Riepilogo passaggio',exact:true})).toBeVisible();
  await page.getByRole('checkbox',{name:'Confermo i dati e le responsabilità iniziali di questa pratica',exact:true}).check();
}
async function screen(page:Page,name:string,width:number) {
  await page.setViewportSize({width,height:950});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:path.join(evidence,`${name}-${width}.png`),fullPage:true});
}
test.beforeAll(async()=>{await assertAiOrchestratorEphemeralDatabaseIdentity(db);expect(f.synthetic).toBe(true);});
test.afterAll(async()=>db.$disconnect());
test('project shortcut opens the existing canonical practice by keyboard; GET never writes and commercial route is denied',async({browser})=>{
  const ac=await browser.newContext(),cc=await browser.newContext(),admin=await ac.newPage(),commercial=await cc.newPage();
  await login(admin); await login(commercial,true); const row=await fixture();
  const practice=await db.technicalPractice.create({data:{clientId:row.client.id,projectId:row.project.id,title:'Pratica già collegata',practiceType:'test',targetEntity:'test',createdById:f.adminId}});
  await admin.goto(`/projects/${row.project.id}`);
  const link=admin.getByRole('link',{name:'Passaggio all’Ufficio Tecnico',exact:true}); await link.focus(); await link.press('Enter');
  await expect(admin).toHaveURL(new RegExp(`/projects/${row.project.id}/technical-handoff$`));
  await expect(admin.getByRole('heading',{name:'Pratiche già collegate',exact:true})).toBeVisible();
  await expect(admin.getByRole('button',{name:'Prepara pratica',exact:true})).toHaveCount(0);
  await screen(admin,'existing',1440);await screen(admin,'existing',390);
  await admin.getByRole('link',{name:'Apri pratica',exact:true}).click();
  await expect(admin).toHaveURL(new RegExp(`/technical-office/practices/${practice.id}$`));
  await expect(admin.getByRole('heading',{name:'Pratica già collegata',exact:true})).toBeVisible();
  const denied=await commercial.goto(`/projects/${row.project.id}/technical-handoff`);
  expect(denied?.status()).toBe(404);await expect(commercial.getByText('Pratica già collegata',{exact:true})).toHaveCount(0);
  expect(await db.technicalPractice.count({where:{projectId:row.project.id}})).toBe(1);
  expect(await db.auditLog.count({where:{entityId:row.project.id,event:'project_practice_prepared'}})).toBe(0);
  await ac.close();await cc.close();
});
test('native exact preview and lost-response recovery reopen one practice without copying access or starting a service',async({browser})=>{
  const context=await browser.newContext(),page=await context.newPage();await login(page);const row=await fixture();
  const before=await Promise.all([db.technicalAssignment.count(),db.approvedCommunication.count(),db.task.count(),db.document.count()]);
  await open(page,row.project.id);await preview(page);await screen(page,'preview',1440);await screen(page,'preview',390);
  await context.clearCookies({name:'fai_crm_privileged_step_up'});
  await page.getByRole('button',{name:'Prepara pratica',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Conferma identità senza lasciare il lavoro',exact:true})).toBeVisible();
  expect(await db.technicalPractice.count({where:{projectId:row.project.id}})).toBe(0);
  await expect(page.getByLabel('Tipologia pratica',{exact:true})).toHaveValue('Preparazione sintetica');
  await page.getByLabel('Password corrente',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Conferma identità e conserva le scelte',exact:true}).click();
  await expect(page.getByText('Identità confermata. La conferma dura 30 minuti. Le scelte sono conservate; scegli personalmente quando proseguire.',{exact:true})).toBeVisible();
  let captured:{url:string;headers:Record<string,string>;body:Buffer}|undefined;
  await page.route(`**/projects/${row.project.id}/technical-handoff*`,async route=>{
    const request=route.request();
    if(request.method()!=='POST'){await route.continue();return;}
    captured={url:request.url(),headers:await request.allHeaders(),body:request.postDataBuffer()!};
    const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort('failed');
  });
  await page.getByRole('button',{name:'Prepara pratica',exact:true}).click();
  await expect(page.getByRole('button',{name:'Verifica esito',exact:true})).toBeVisible();
  expect(captured).toBeDefined();const command=new URL(page.url()).searchParams.get('command');expect(command).toMatch(/^[a-f0-9-]{36}$/);
  await page.unrouteAll({behavior:'wait'});await page.reload();
  await expect(page.getByRole('button',{name:'Controlla il passaggio',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Verifica esito',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Preparazione già registrata');
  const receipt=await db.auditLog.findUniqueOrThrow({where:{id:command!}});
  const saved=await db.technicalPractice.findMany({where:{projectId:row.project.id}});expect(saved).toHaveLength(1);
  expect(receipt.event).toBe('project_practice_prepared');expect(saved[0].status).toBe('da_progettare');expect(saved[0].clientServiceId).toBeNull();
  expect(saved[0].submittedAt).toBeNull();expect(saved[0].commercialOwnerId).toBe(f.commercialId);expect(saved[0].technicalOwnerId).toBe(f.readerId);
  // Replay the real native command after the lost response; no invented action ID.
  const headers={...captured!.headers};delete headers['content-length'];delete headers.host;
  await context.request.post(captured!.url,{headers,data:captured!.body});
  expect(await db.technicalPractice.count({where:{projectId:row.project.id}})).toBe(1);
  expect(await db.auditLog.count({where:{id:command!}})).toBe(1);
  expect(await Promise.all([db.technicalAssignment.count(),db.approvedCommunication.count(),db.task.count(),db.document.count()])).toEqual(before);
  await screen(page,'receipt',390);await page.getByRole('link',{name:'Apri pratica preparata',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`/technical-office/practices/${saved[0].id}$`));await context.close();
});
test('stale preview refuses a new save and missing receipt stays blocked across reload',async({browser})=>{
  const context=await browser.newContext(),page=await context.newPage();await login(page);const row=await fixture();
  await open(page,row.project.id);await preview(page);
  await db.project.update({where:{id:row.project.id},data:{title:'Changed by another synthetic request'}});
  await page.getByRole('button',{name:'Prepara pratica',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Preparazione non salvata');
  expect(new URL(page.url()).searchParams.has('command')).toBe(false);
  expect(await db.technicalPractice.count({where:{projectId:row.project.id}})).toBe(0);
  await page.goto(`/projects/${row.project.id}/technical-handoff?command=${randomUUID()}`);
  await expect(page.getByRole('button',{name:'Controlla il passaggio',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Verifica esito',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Decisione non osservata');await screen(page,'unobserved',390);
  await expect(page.getByRole('button',{name:'Controlla il passaggio',exact:true})).toBeDisabled();
  expect(await db.technicalPractice.count({where:{projectId:row.project.id}})).toBe(0);await context.close();
});
