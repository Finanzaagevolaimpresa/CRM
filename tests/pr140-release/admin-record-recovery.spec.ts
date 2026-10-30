import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test('schema73 exact-image restart preserves Admin corrections, operational holds, restore history and closed-command reconciliation after fresh login', async ({ page }) => {
  const f = JSON.parse(readFileSync(process.env.R05_ADMIN_RECORD_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; noSend: boolean; adminEmail: string; clientId: string; title: string; commandIds: string[]; closedId: string;
    lifecycleIntakeId:string;lifecycleCommands:string[];lifecycleClosedId:string;
  };
  expect(f.synthetic && f.noSend).toBe(true);
  const origin = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  await page.goto(origin + '/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(f.adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Login interno', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(origin + '/admin/records/Client/' + f.clientId);
  await expect(page.getByRole('textbox', { name: 'Denominazione cliente', exact: true })).toHaveValue(f.title);
  await expect(page.getByRole('combobox', { name: 'Operazione', exact: true })).toHaveValue('UPDATE');
  await expect(page.getByRole('article').filter({ hasText: 'Synthetic Admin restart preservation' })).toHaveCount(3);
  await page.goto(origin + '/admin/records/Client/' + f.clientId + '?command=' + f.closedId + '&decision=' + f.closedId);
  await page.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Tentativo chiuso senza modifica operativa.');
  await expect(page.getByRole('link', { name: 'Riapri per una nuova operazione', exact: true })).toBeVisible();
  await page.goto(origin+'/admin/lifecycle/ControlledIntake/'+f.lifecycleIntakeId);
  await expect(page.getByText('Archiviato',{exact:true}).first()).toBeVisible();
  await expect(page.getByText(/Synthetic operational restart preservation/)).toHaveCount(3);
  await page.goto(origin+'/admin/lifecycle/ControlledIntake/'+f.lifecycleIntakeId+'?command='+f.lifecycleClosedId+'&decision='+f.lifecycleClosedId);
  await page.getByRole('button',{name:'Verifica esito registrato',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Tentativo chiuso senza modifica.');
});
