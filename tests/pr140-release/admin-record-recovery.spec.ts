import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';

test('schema74 candidate, compatible return and resume preserve corrections, exact private versions and effective account permissions', async ({ page }) => {
  const f = JSON.parse(readFileSync(process.env.R05_ADMIN_RECORD_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; noSend: boolean; adminEmail: string; clientId: string; title: string; commandIds: string[]; closedId: string;
    lifecycleIntakeId:string;lifecycleCommands:string[];lifecycleClosedId:string;
    metadataId:string;metadataCommands:string[];metadataClosedId:string;metadataAdminEmail:string;metadataTitle:string;
    privateClientId:string;privateVersionId:string;privateVersionSha256:string;privateVersionBytes:string;
    originalVersionId:string;originalVersionSha256:string;practiceId:string;originalContractId:string;
    currentContractId:string;profileUserEmail:string;
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
  await page.goto(origin + '/practice-readiness');
  const practice = page.locator('#practice-' + f.practiceId);
  await expect(practice).toContainText('Collegamenti rettificati dall’Admin');
  await expect(practice).toContainText('contratto ' + f.originalContractId);
  await expect(practice.locator('p').filter({ hasText: /^Residui:/ })).not.toContainText('incarico_formalizzato');
  await expect(practice.locator('select[name="contractId"] option[value="' + f.currentContractId + '"]')).toHaveCount(1);
  await page.goto(origin + '/settings/users');
  const creation = page.getByRole('form', { name: 'Crea utente interno', exact: true });
  await creation.getByRole('combobox', { name: 'Ruolo', exact: true }).selectOption('commerciale');
  await expect(creation).toContainText('Profilo selezionato · revisione 1:');
  await expect(creation.locator('input[name="roleProfileVersion"]')).toHaveValue(/^[a-f0-9]{64}$/);
  await page.context().clearCookies();await page.goto(origin+'/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({state:'attached'});
  await page.getByLabel('Email',{exact:true}).fill(f.metadataAdminEmail);
  await page.getByLabel('Password',{exact:true}).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
  await page.getByRole('button',{name:'Login interno',exact:true}).click();await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(origin+'/admin/private-documents/'+f.metadataId);
  await expect(page.getByRole('textbox',{name:'Titolo amministrativo',exact:true})).toHaveValue(f.metadataTitle);
  await expect(page.getByRole('heading',{name:'Metadati correnti · revisione 3',exact:true})).toBeVisible();
  await page.goto(origin+'/admin/private-documents/'+f.metadataId+'?command='+f.metadataClosedId+'&decision='+f.metadataClosedId);
  await page.getByRole('button',{name:'Verifica esito registrato',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Tentativo chiuso senza correzione.');
  await page.goto(origin + '/clients/' + f.privateClientId + '/acquired-documents');
  for (const [number, versionId, sha256] of [[1, f.originalVersionId, f.originalVersionSha256], [2, f.privateVersionId, f.privateVersionSha256]] as const) {
    const href = '/acquired-documents/' + f.metadataId + '?version=' + versionId;
    await expect(page.getByRole('link', { name: 'Scarica versione ' + number, exact: true })).toHaveAttribute('href', href + '&download=1');
    for (const suffix of ['', '&download=1']) {
      const response = await page.request.get(origin + href + suffix); expect(response.status()).toBe(200);
      const bytes = await response.body(); expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
      if (number === 2) expect(bytes.toString()).toBe(f.privateVersionBytes);
      expect(response.headers()['content-disposition']).toMatch(suffix ? /^attachment;/ : /^inline;/);
      expect(response.headers()['cache-control']).toContain('private, no-store');
    }
  }
  if (process.env.R05_SELECTIVE_PHASE === 'restart') {
    for (const path of ['/admin/private-documents/' + f.metadataId + '/versions', '/admin/links/PracticeReadiness/' + f.practiceId, '/settings/roles/commerciale']) {
      expect((await page.request.get(origin + path)).status()).toBe(404);
    }
    await expect(page.getByRole('link', { name: 'Carica o ripristina una versione privata', exact: true })).toHaveCount(0);
  }
  await page.context().clearCookies(); await page.goto(origin + '/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(f.profileUserEmail);
  await page.getByLabel('Password', { exact: true }).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Login interno', exact: true }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(origin + '/leads'); await expect(page).toHaveURL(/\/dashboard$/);
  for (const version of [f.originalVersionId, f.privateVersionId]) {
    expect((await page.request.get(origin + '/acquired-documents/' + f.metadataId + '?version=' + version + '&download=1')).status()).toBe(404);
  }
});
