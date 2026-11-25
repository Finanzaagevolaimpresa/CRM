import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';

export const syntheticPassword = 'fixture-only-setter-call-browser-local-2026';
async function seed() {
  const db = new PrismaClient();
  try {
    await assertAiOrchestratorEphemeralDatabaseIdentity(db);
    assert.equal(process.env.APP_ENV,'test'); assert.equal(await db.user.count(),0);
    const hash = await bcrypt.hash(syntheticPassword,10);
    const admin = await syntheticAuthority(db,hash), setter = await syntheticPerson(db,'Setter Michela · simulazione','commerciale',hash);
    const second = await syntheticPerson(db,'Secondo referente · simulazione','commerciale',hash);
    const tech = await syntheticPerson(db,'Tecnico · simulazione','consulente',hash);
    await db.commercialLeadSlaPolicyVersion.create({ data: { policyCode:'COMMERCIAL_FIRST_RESPONSE', version:1, status:'ACTIVE',
      calendarCode:'CONTINUOUS_24X7', timezoneCode:'UTC', responseTargetSeconds:3600, createdById:admin.user.id } });
    await db.selectiveLeadAuthority.create({ data: { userId:admin.user.id, enabled:true } });
    for (const p of [admin,setter,second,tech]) await db.$transaction(tx => revokeAllInternalSessions(tx,p.user.id,'INTERNAL_GLOBAL',admin.user.id));
    await assertRegistryActivationReady(db);
    const who = (p: typeof admin) => ({ id:p.user.id,email:p.user.email });
    const out=process.env.SETTER_EVIDENCE!;
    mkdirSync(out,{recursive:true});writeFileSync(join(out,'fixture.json'),JSON.stringify({synthetic:true,admin:who(admin),setter:who(setter),second:who(second),tech:who(tech)}));
  } finally { await db.$disconnect(); }
}
seed().catch(error => { console.error(error);process.exitCode=1; });
