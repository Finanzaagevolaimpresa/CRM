import { prisma } from '../src/lib/prisma';
import { prepareServiceCatalogV2 } from '../src/lib/service-catalog-v2-persistence';

prepareServiceCatalogV2(prisma).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).finally(() => prisma.$disconnect());
