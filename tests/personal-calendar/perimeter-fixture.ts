import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { provisionCalendarPerimeter } from './perimeter-fixtures';

const db = new PrismaClient();
async function run() {
  assert(process.env.FLOW_EVIDENCE, 'FLOW_EVIDENCE_REQUIRED');
  const value = await provisionCalendarPerimeter(db);
  mkdirSync(process.env.FLOW_EVIDENCE, { recursive: true });
  writeFileSync(join(process.env.FLOW_EVIDENCE, 'calendar-perimeter-fixture.json'), JSON.stringify(value), { flag: 'wx' });
  console.log('SYNTHETIC_CALENDAR_PERIMETER_READY');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
