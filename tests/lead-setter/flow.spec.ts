import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { romeDateTimeInput } from '../../src/lib/rome-date-time';

const db = new PrismaClient(), evidence = process.env.SETTER_EVIDENCE!;
const fixture = JSON.parse(readFileSync(join(evidence,'fixture.json'),'utf8')) as Record<string,{ id:string;email:string }>;
const password = 'fixture-only-setter-call-browser-local-2026';
async function login(page: Page,email: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({state:'attached'});
  await page.getByLabel('Email',{exact:true}).fill(email); await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Login interno',exact:true}).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function checkQueue(page: Page, queue: string, title: string, present: boolean) {
  await page.goto('/leads/work?queue=' + queue);
  const count = await page.getByRole('heading',{name:/^\d+ lead in elenco$/}).innerText();
  const rows = page.locator('main a[href^="/leads/"]').filter({ hasText:title });
  await expect(rows).toHaveCount(present ? 1 : 0);
  return Number(count.split(' ')[0]);
}
test.afterAll(async () => { await db.$disconnect(); });
test('Admin assegna; il referente registra tentativo, contatto e video; cestino e ripristino conservano storia e perimetro', async ({ browser }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const contexts = await Promise.all([1,2,3,4].map(() => browser.newContext()));
  try {
    const [admin,setter,second,tech] = await Promise.all(contexts.map(c => c.newPage()));
    for (const [page,who] of [[admin,'admin'],[setter,'setter'],[second,'second'],[tech,'tech']] as const) await login(page,fixture[who].email);
    const title = 'Qualifica setter ' + randomUUID();
    await admin.goto('/leads'); await admin.getByPlaceholder('Nome / ragione sociale',{exact:true}).fill(title);
    await admin.getByPlaceholder('Nome referente',{exact:true}).fill('Persona'); await admin.getByPlaceholder('Cognome referente',{exact:true}).fill('Sintetica');
    await admin.getByRole('button',{name:'Crea lead',exact:true}).click(); await expect(admin).toHaveURL(/\/leads\?created=1$/);
    const lead = await db.lead.findFirstOrThrow({ where:{companyName:title} });
    const unassignedBefore = await checkQueue(admin,'unassigned',title,true);
    const entered = await checkQueue(admin,'today',title,true);
    await admin.goto('/dashboard');
    const area = admin.locator('section[aria-labelledby="counter-area-commerciale"]');
    for (const [label,n] of [['Entrati oggi',entered],['Da assegnare',unassignedBefore]] as const)
      await expect(area.getByRole('link',{name:new RegExp(label)}).locator('[data-counter-final]')).toHaveAttribute('data-counter-final',String(n));
    const inbox = '/leads/inbox?lead=' + lead.id, detail = '/leads/' + lead.id;
    await admin.goto(inbox); await admin.getByRole('link',{name:'Conferma identità per assegnare'}).click();
    await expect(admin.locator('[data-identity-ready="true"]')).toBeVisible();
    await admin.getByLabel('Password corrente',{exact:true}).fill(password);
    await admin.getByRole('button',{name:'Conferma per 30 minuti',exact:true}).click();
    await expect(admin).toHaveURL(/\/leads\/inbox$/);
    async function assign(to:string) {
      await admin.goto(inbox); await admin.getByLabel('Referente commerciale',{exact:true}).selectOption(fixture[to].id);
      await admin.getByRole('button',{name:'Assegna',exact:true}).click();
      await expect.poll(async () => (await db.lead.findUniqueOrThrow({where:{id:lead.id}})).assignedToId).toBe(fixture[to].id);
    }
    await assign('second'); await checkQueue(second,'contact',title,true);
    await assign('setter'); await checkQueue(second,'contact',title,false); await checkQueue(setter,'contact',title,true);
    expect(await checkQueue(admin,'unassigned',title,false)).toBe(unassignedBefore - 1);
    await setter.goto('/notifications'); await expect(setter.locator('a[href="'+detail+'"]').first()).toBeVisible();
    await tech.goto(detail); await expect(tech.getByRole('button',{name:'Salva chiamata e prossimo passo'})).toHaveCount(0);
    await setter.goto(detail); const save = setter.getByRole('button',{name:'Salva chiamata e prossimo passo'});
    await setter.getByLabel('Data del richiamo',{exact:true}).fill(romeDateTimeInput(new Date()).slice(0,10)); await save.click();
    await expect(setter.getByRole('status').filter({hasText:'Chiamata e prossimo passo salvati'})).toBeVisible();
    await checkQueue(setter,'contact',title,true); await checkQueue(setter,'callbacks',title,true);
    await setter.goto(detail); await setter.getByRole('button',{name:'Registra un’altra telefonata'}).click();
    await setter.getByLabel('Esito',{exact:true}).selectOption('VIDEO_BOOKED');
    await setter.getByLabel('Indicazioni per il consulente').fill('Progetto e prossima riunione sintetici.');
    await setter.getByLabel('Data e ora della videochiamata (Roma)').fill(romeDateTimeInput(new Date(Date.now()+86400000)).slice(0,16));
    await save.click(); await expect(setter.getByRole('status').filter({hasText:'Chiamata e prossimo passo salvati'})).toBeVisible();
    await checkQueue(setter,'contact',title,false); await checkQueue(setter,'videos',title,true);
    await admin.goto(detail); await admin.getByRole('button',{name:'Sposta nel cestino',exact:true}).click();
    await admin.getByRole('dialog').getByRole('checkbox').check(); await admin.getByRole('dialog').getByRole('button',{name:'Sposta nel cestino',exact:true}).click();
    await expect.poll(async () => !!(await db.lead.findUniqueOrThrow({where:{id:lead.id}})).deletedAt).toBe(true);
    await checkQueue(setter,'videos',title,false);
    await admin.goto('/admin/records'); await admin.getByLabel('Area',{exact:true}).selectOption('Lead');
    await admin.getByLabel('Cerca nel cestino',{exact:true}).fill(title); await admin.getByRole('button',{name:'Apri cestino'}).click();
    await admin.getByRole('button',{name:'Ripristina lead',exact:true}).click(); await admin.getByRole('dialog').getByRole('checkbox').check();
    await admin.getByRole('dialog').getByRole('button',{name:'Ripristina lead',exact:true}).click();
    await expect.poll(async () => (await db.lead.findUniqueOrThrow({where:{id:lead.id}})).deletedAt).toBeNull();
    await checkQueue(setter,'videos',title,true);
    await setter.goto(detail); await setter.getByRole('button',{name:'Registra un’altra telefonata'}).click();
    await setter.getByLabel('Esito',{exact:true}).selectOption('VIDEO_HELD');
    await setter.getByLabel('Indicazioni per il consulente').fill('Video svolto, sintesi di prova.');
    await setter.getByLabel('Prossimo passo',{exact:true}).selectOption('NONE'); await save.click();
    await expect.poll(() => db.leadSetterCall.count({where:{leadId:lead.id}})).toBe(3);
    await checkQueue(setter,'videos',title,false);
    expect(await db.auditLog.count({where:{entityId:lead.id,event:'responsibility_accepted'}})).toBe(0);
    const receipts = await db.leadSetterCall.findMany({where:{leadId:lead.id},orderBy:{recordedAt:'asc'},select:{id:true,actorId:true,outcome:true,nextKind:true,recordedAt:true}});
    expect(receipts.every(r => r.actorId === fixture.setter.id)).toBe(true);
    writeFileSync(join(evidence,'browser-receipt.json'),JSON.stringify({synthetic:true,at:new Date(),lead:lead.id,entered,unassignedBefore,receipts}));
  } finally { await Promise.all(contexts.map(c => c.close())); }
});
