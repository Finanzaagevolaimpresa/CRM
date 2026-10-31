import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync,readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson,syntheticSession } from '../selective-sharing/fixtures';
import {readAdminPrivateDocumentMetadata,saveAdminPrivateDocumentMetadata,reconcileAdminPrivateDocumentMetadata} from '../../src/lib/admin-private-document-metadata';
import { createPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';
import { loadAdminRecord, saveAdminRecord, closeAdminRecordAttempt, readAdminRecordReceipt } from '../../src/lib/admin-records';
import { adminHistoryFixture } from '../admin-records/history-fixture';
import { readAdminOperationalState, saveAdminOperationalState, reconcileAdminOperationalState } from '../../src/lib/admin-operational-lifecycle';
import { readAdminPrivateVersions, saveAdminPrivateVersion } from '../../src/lib/admin-private-document-versions';
import { lifecycleReadinessFixture } from '../admin-lifecycle/fixtures';
import { readAdminOperationalLink, previewAdminOperationalLink, saveAdminOperationalLink } from '../../src/lib/admin-operational-links';
import { readAdminRoleProfile, saveAdminRoleProfile } from '../../src/lib/admin-role-profiles';
import { executeAdminUserCommand } from '../../src/lib/admin-user-commands';
import { adminUserVersion } from '../../src/lib/admin-user-command-contract';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert(process.env.R05_ADMIN_RECORD_RECOVERY_FIXTURE);
  process.env.PRACTICE_READINESS_MODE = 'synthetic';
  process.env.CONTROLLED_INTAKE_MODE = 'synthetic';
  process.env.PRIVILEGED_ACCESS_MODE = 'enforced';
  const owner = await db.user.findUniqueOrThrow({ where: { id: 'release-owner' } });
  const admin = await syntheticPerson(db, 'Synthetic Admin correction author', 'admin', owner.passwordHash);
  const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
  const proof = { key, sessionToken: admin.token, stepUpToken: createPrivilegedStepUpToken({ key, userId: admin.user.id,
    sessionToken: admin.token, role: 'admin' }) };
  const client = await db.client.create({ data: { displayName: 'SYNTHETIC_ADMIN_BEFORE', type: 'persona_fisica' } });
  const commandIds: string[] = [];
  for (const operation of ['UPDATE', 'TRASH', 'RESTORE'] as const) {
    const form = await loadAdminRecord(db, admin.session, 'Client', client.id);
    const command = { commandId: randomUUID(), model: 'Client', id: client.id, operation, expectedVersion: form.version,
      reason: 'Synthetic Admin restart preservation', values: operation === 'UPDATE' ? { ...form.values, displayName: 'SYNTHETIC_ADMIN_PRESERVED' } : {} };
    await saveAdminRecord(db, admin.session, command, proof);
    assert.equal((await saveAdminRecord(db, admin.session, command, proof)).replayed, true);
    commandIds.push(command.commandId);
  }
  const closedId = randomUUID();
  assert.equal((await closeAdminRecordAttempt(db, admin.session, { commandId: closedId, model: 'Client', id: client.id })).closed, true);
  assert.equal((await readAdminRecordReceipt(db, admin.session, closedId))?.closed, true);
  const persisted = await db.client.findUniqueOrThrow({ where: { id: client.id } });
  assert.equal(persisted.displayName, 'SYNTHETIC_ADMIN_PRESERVED'); assert.equal(persisted.deletedAt, null);
  assert.equal(await db.adminRecordRevision.count({ where: { actorId: admin.user.id } }), 4);
  const lifecycle=await adminHistoryFixture(db,admin.user.id),lifecycleCommands:string[]=[];
  for(const state of ['BLOCKED','ACTIVE','ARCHIVED'] as const){
    const form=await readAdminOperationalState(db,admin.session,'ControlledIntake',lifecycle.intake.id);
    const command={commandId:randomUUID(),model:'ControlledIntake' as const,id:lifecycle.intake.id,state,
      expectedVersion:form.expectedVersion,reason:'Synthetic operational restart preservation',confirmed:true};
    await saveAdminOperationalState(db,admin.session,command,proof);lifecycleCommands.push(command.commandId);
  }
  const lifecycleClosedId=randomUUID();
  assert.equal((await reconcileAdminOperationalState(db,admin.session,{commandId:lifecycleClosedId,model:'ControlledIntake',
    id:lifecycle.intake.id,close:true})).status,'CLOSED');
  const [technicalAuthority]=await db.$queryRaw<Array<{userId:string}>>`SELECT "userId" FROM "TechnicalAssignmentAuthority" WHERE id='technical-assignment' AND enabled`;
  assert(technicalAuthority);
  const metadataUser=await db.user.findUniqueOrThrow({where:{id:technicalAuthority.userId}});
  const metadataAdmin={user:metadataUser,...await syntheticSession(db,metadataUser)};
  const metadataFixture=JSON.parse(readFileSync(process.env.R05_UPLOAD_RECOVERY_FIXTURE!,'utf8')) as {acquisition:{documentId:string;title:string}};
  const metadataId=metadataFixture.acquisition.documentId;
  const metadataCommands:string[]=[],metadataProof={key,sessionToken:metadataAdmin.token,stepUpToken:createPrivilegedStepUpToken({key,userId:metadataUser.id,sessionToken:metadataAdmin.token,role:'admin'})};
  for(const title of ['SYNTHETIC_PRIVATE_METADATA_BEFORE','SYNTHETIC_PRIVATE_METADATA_INTERMEDIATE',metadataFixture.acquisition.title]){
    const form=await readAdminPrivateDocumentMetadata(db,metadataAdmin.session,metadataId),commandId=randomUUID();
    await saveAdminPrivateDocumentMetadata(db,metadataAdmin.session,{commandId,id:metadataId,expectedVersion:form.expectedVersion,
      values:{...form.current.values,title},reason:'Synthetic private metadata restart preservation',confirmed:true},metadataProof);
    metadataCommands.push(commandId);
  }
  const metadataClosedId=randomUUID();
  assert.equal((await reconcileAdminPrivateDocumentMetadata(db,metadataAdmin.session,{commandId:metadataClosedId,id:metadataId,close:true})).status,'CLOSED');
  const residualCommands: string[] = [];
  const privateBefore = await readAdminPrivateVersions(db, metadataAdmin.session, metadataId);
  const versionCommand = randomUUID(), versionBytes = 'SYNTHETIC_SCHEMA74_COMPATIBLE_PRIVATE_VERSION';
  await saveAdminPrivateVersion(db, metadataAdmin.session, { commandId: versionCommand, id: metadataId,
    expectedVersion: privateBefore.expectedVersion, restoreVersionId: null, reason: 'Synthetic schema74 recovery version', confirmed: true },
    new File([versionBytes], 'schema74-recovery.txt', { type: 'text/plain' }), metadataProof);
  residualCommands.push(versionCommand);
  const privateAfter = await readAdminPrivateVersions(db, metadataAdmin.session, metadataId), version = privateAfter.versions.at(-1)!;
  assert.equal(privateAfter.versions.length, 2); assert.equal(version.version, 2);
  const source = await lifecycleReadinessFixture(db, admin.session);
  const practiceBefore = await db.practiceReadiness.findUniqueOrThrow({ where: { id: source.practice.id } });
  const contract = await db.contract.findUniqueOrThrow({ where: { id: practiceBefore.contractId! } });
  const alternative = await db.contract.create({ data: { clientId: contract.clientId, projectId: contract.projectId,
    contractNumber: randomUUID(), serviceName: contract.serviceName, taxableAmount: contract.taxableAmount,
    vatAmount: contract.vatAmount, totalAmount: contract.totalAmount, status: 'firmato', signedAt: contract.signedAt,
    signedDocumentId: contract.signedDocumentId } });
  const links = await readAdminOperationalLink(db, admin.session, 'PracticeReadiness', source.practice.id);
  const choice = { model: 'PracticeReadiness' as const, id: source.practice.id, values: { ...links.values, contractId: alternative.id } };
  const preview = await previewAdminOperationalLink(db, admin.session, choice), linkCommand = randomUUID();
  await saveAdminOperationalLink(db, admin.session, { ...choice, commandId: linkCommand, expectedVersion: preview.version,
    reason: 'Synthetic schema74 current formalization recovery', confirmed: true }, proof);
  residualCommands.push(linkCommand);
  const practiceAfter = await db.practiceReadiness.findUniqueOrThrow({ where: { id: source.practice.id } });
  assert.equal(practiceAfter.currentFormalizationId, practiceBefore.currentFormalizationId);
  assert.deepEqual(practiceAfter.startEvidence, practiceBefore.startEvidence);
  assert.equal(practiceAfter.contractId, alternative.id);
  const role = 'commerciale', preset = await readAdminRoleProfile(db, admin.session, role), profileCommand = randomUUID();
  await saveAdminRoleProfile(db, admin.session, { role, commandId: profileCommand, expectedVersion: preset.version,
    reason: 'Synthetic schema74 explicit profile recovery', overrides: [{ permission: 'lead.read', allowed: false }], confirmed: true }, proof);
  const profile = await readAdminRoleProfile(db, admin.session, role);
  const profileUser = await syntheticPerson(db, 'Synthetic residual profile account', role, owner.passwordHash);
  const target = await db.user.findUniqueOrThrow({ where: { id: profileUser.user.id }, include: { permissionOverrides: true } });
  const applyCommand = randomUUID();
  await executeAdminUserCommand(db, admin.session, { operation: 'APPLY_ROLE_PROFILE', commandId: applyCommand,
    userId: target.id, expectedVersion: adminUserVersion(target) }, { roleProfileVersion: profile.version, confirmed: true }, proof);
  residualCommands.push(profileCommand, applyCommand);
  writeFileSync(process.env.R05_ADMIN_RECORD_RECOVERY_FIXTURE, JSON.stringify({ synthetic: true, noSend: true,
    adminEmail: admin.user.email, clientId: client.id, title: persisted.displayName, commandIds, closedId,
    lifecycleIntakeId:lifecycle.intake.id,lifecycleCommands,lifecycleClosedId,
    metadataId,metadataCommands,metadataClosedId,metadataAdminEmail:metadataUser.email,metadataTitle:metadataFixture.acquisition.title,
    residualCommands, privateClientId: privateAfter.clientId, privateVersionId: version.versionId, privateVersionSha256: version.sha256,
    privateVersionBytes: versionBytes, originalVersionId: privateBefore.versions[0].versionId,
    originalVersionSha256: privateBefore.versions[0].sha256, practiceId: source.practice.id, originalContractId: contract.id,
    currentContractId: alternative.id, originalFormalizationId: practiceBefore.currentFormalizationId,
    profileUserId: target.id, profileUserEmail: target.email }, null, 2) + '\n');
  console.log('SCHEMA74_ADMIN_RECORD_RESTART_STATES_READY');
}
void main().finally(() => db.$disconnect()).catch(error => { console.error('SCHEMA74_ADMIN_RECORD_RESTART_FIXTURE_FAILED', error); process.exitCode = 1; });
