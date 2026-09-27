import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';

const app = 'http://127.0.0.1:3000';
const evidence = process.env.M3_BROWSER_EVIDENCE!;
const db = new PrismaClient();
async function login(page: Page, email: string) {
  await page.goto(`${app}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(process.env.M3_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(`${app}/dashboard`);
}
test.afterAll(() => db.$disconnect());
test('M3 browser: persisted receipts, separate requests, visible retry and fresh scope denial', async ({ browser }) => {
  assert.equal(process.env.M3_BROWSER_CONFIRMED, '1');
  assert.equal(assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1',
    destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL,
    sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV }), true);
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const fixture = JSON.parse(readFileSync(join(evidence, 'fixture.json'), 'utf8'));
  const adminContext = await browser.newContext();
  const operatorContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const operator = await operatorContext.newPage();
  await login(admin, 'm3-admin@invalid.test');
  await admin.goto(`${app}/leads/acquisition`);
  await expect(admin.getByRole('heading', { name: 'Acquisizione lead', exact: true })).toBeVisible();
  await expect(admin.getByText('WORDPRESS / M3_BROWSER_SYNTHETIC', { exact: true })).toBeVisible();
  await admin.getByRole('link', { name: 'Errori e retry' }).click();
  await expect(admin.getByRole('heading', { name: 'Tentativo successivo previsto', exact: true })).toBeVisible();
  await expect(admin.getByText('Richiesta sintetica M3 numero 3', { exact: true })).toBeVisible();
  await expect(admin.getByText('Richiesta sintetica M3 numero 1', { exact: true })).toHaveCount(0);
  await admin.goto(`${app}/leads/${fixture.leadId}`);
  await admin.getByRole('link', { name: 'Richieste e provenienza', exact: true }).click();
  await expect(admin).toHaveURL(`${app}/leads/${fixture.leadId}/requests`);
  await expect(admin.getByRole('heading', { name: 'Richieste e provenienza', exact: true })).toBeVisible();
  for (const number of [1, 2]) await expect(admin.getByText(`Richiesta sintetica M3 numero ${number}`, { exact: true })).toBeVisible();
  await expect(admin.getByText(/M3-CAMPAIGN-1/)).toBeVisible();
  await expect(admin.getByText(/M3-CAMPAIGN-2/)).toBeVisible();
  await login(operator, 'm3-operator@invalid.test');
  await operator.goto(`${app}/leads/${fixture.leadId}/requests`);
  await expect(operator.getByText('Richiesta sintetica M3 numero 2', { exact: true })).toBeVisible();
  await expect(operator.getByText(/SYNTHETIC_PRIVACY_NOTICE/)).toHaveCount(0);
  await expect(operator.getByText(/SYNTHETIC_MARKETING_NOTICE/)).toHaveCount(0);
  const global = await operator.goto(`${app}/leads/acquisition`);
  expect(global?.status() === 404 || !operator.url().endsWith('/leads/acquisition')).toBe(true);
  await expect(operator.getByText('Richiesta sintetica M3 numero 3', { exact: true })).toHaveCount(0);
  await db.lead.update({ where: { id: fixture.leadId }, data: { assignedToId: null } });
  const denied = await operator.goto(`${app}/leads/${fixture.leadId}/requests`);
  expect(denied?.status()).toBe(404);
  await expect(operator.getByText('Richiesta sintetica M3 numero 2', { exact: true })).toHaveCount(0);
  writeFileSync(join(evidence, 'browser-proof.json'), JSON.stringify({ status: 'PASS', synthetic: true,
    requestsPreserved: 2, retryVisible: true, replayDuplicated: false, reassignmentDenied: true,
    adminOnlyGlobalView: true, productionConnected: false }));
  await adminContext.close(); await operatorContext.close();
});
