import { PrismaClient } from '@prisma/client';
import { provisionCatalogBrowserFixtures } from './provision-service';

const db = new PrismaClient();
void provisionCatalogBrowserFixtures(db, process.env.CATALOG_BROWSER_PASSWORD)
  .catch(() => { process.stderr.write('CATALOG_BROWSER_PROVISION_FAILED\n'); process.exitCode = 1; })
  .finally(() => db.$disconnect());
