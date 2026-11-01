import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test('candidate, compatible return and resume retain effective SMTP outcome and the original uncertain receipt',async({page})=>{
  const f=JSON.parse(readFileSync(process.env.R05_ORDINARY_RECOVERY_FIXTURE!,'utf8')) as {
    synthetic:boolean;persistenceOnly:boolean;adminEmail:string;practiceId:string;messageId:string;
    attemptId:string;reconciliationId:string;sourceHash:string;originalOutcome:string;
  };
  expect(f.synthetic&&f.persistenceOnly).toBe(true);
  const origin=process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  await page.goto(origin+'/login');await page.locator('[data-interactive-ready="true"]').waitFor({state:'attached'});
  await page.getByLabel('Email',{exact:true}).fill(f.adminEmail);
  await page.getByLabel('Password',{exact:true}).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
  await page.getByRole('button',{name:'Login interno',exact:true}).click();await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(origin+'/communications?kind=TECHNICAL&practice='+f.practiceId);
  const receipt=page.getByRole('region',{name:'Ricevute email ordinarie',exact:true}).filter({hasText:f.reconciliationId});
  await expect(receipt).toContainText('Versione 1 · Accettata dal server');
  await expect(receipt).toContainText('prova SHA256 '+f.sourceHash);
  await expect(receipt).toContainText('Ricevuta originale conservata: UNCERTAIN');
  const editor=page.locator('[data-recovery-attempt="'+f.attemptId+'"]');
  if(process.env.R05_SELECTIVE_PHASE==='restart') await expect(editor).toHaveCount(0);
  else await expect(editor).toBeVisible();
  await page.reload();await expect(receipt).toContainText(f.reconciliationId);
});
