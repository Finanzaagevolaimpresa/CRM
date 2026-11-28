import { PrismaClient } from '@prisma/client';
import { provisionAgenda } from './fixtures';
const db = new PrismaClient();
provisionAgenda(db).then(() => console.log('AGENDA_SYNTHETIC_FIXTURE_READY'))
  .catch(error => { console.error('AGENDA_SYNTHETIC_FIXTURE_FAILED', { name: error?.name, code: error?.code,
    constraint: error?.meta?.database_error?.match(/constraint "([A-Za-z0-9_]+)"/)?.[1],
    location: String(error?.stack ?? '').split('\n').filter(line => line.includes('fixtures.ts:')).slice(0, 2) });
    process.exitCode = 1; }).finally(() => db.$disconnect());
