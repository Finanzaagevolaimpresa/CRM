import { expect, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { assertSyntheticCatalogDatabase } from '../../src/lib/service-catalog-v2-persistence';
import { workImportReceiptSchema } from '../../src/lib/engagement-work-package';

const db = new PrismaClient();
test.afterAll(() => db.$disconnect());
test('M2 provenance and delivery remain readable after candidate recovery and resume', async ({ page }) => {
  await assertSyntheticCatalogDatabase(db);
  const app = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  expect(new URL(app).hostname).toBe('127.0.0.1');
  const provenance = await db.auditLog.findFirstOrThrow({ where: { event: 'engagement_work_result_import', entityType: 'ClientDossier' } });
  const receipt = workImportReceiptSchema.parse(provenance.after);
  const dossier = await db.clientDossier.findUniqueOrThrow({ where: { id: provenance.entityId! } });
  expect(dossier.currentVersionId).toBe(receipt.versionId);
  expect(dossier.approvedVersionId).toBe(receipt.versionId);
  await page.goto(`${app}/login`);
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email').fill('readiness-owner@invalid.test');
  await page.getByLabel('Password').fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(`${app}/dashboard`);
  await page.goto(`${app}/client-dossiers/${dossier.id}`);
  await expect(page.getByText('Lavorazione manuale con Work', { exact: true })).toBeVisible();
  await page.getByText('Pacchetti e provenienza dei risultati', { exact: false }).click();
  await expect(page.getByText(receipt.referenceCode, { exact: false })).toBeVisible();
  await expect(page.getByText(`Pacchetto ${receipt.packageId}`, { exact: false })).toBeVisible();
  expect(await db.engagementDossierDeliveryReceipt.count({ where: { authorization: { dossierId: dossier.id, versionId: receipt.versionId }, outcome: 'DELIVERED' } })).toBe(1);
});
