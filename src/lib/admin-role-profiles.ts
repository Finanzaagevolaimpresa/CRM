import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { updateActor, type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { mapSerializableConflict, SerializableConflictError } from './serializable';
import { loadAdminRoleProfile } from './admin-role-profile-store';
import { profileRole, roleProfileCommand, roleProfileModel, normalizeRoleProfile,
  roleProfileDigest as digest, RoleProfileError } from './admin-role-profile-contract';

type Tx = Prisma.TransactionClient;
type Authority = Awaited<ReturnType<typeof updateActor>>;
const deny = (): never => { throw new RoleProfileError('DENIED'); };
async function transaction<T>(db: PrismaClient, work: (tx: Tx) => Promise<T>) {
  try { return await db.$transaction(async tx => {
    const result = await work(tx); await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'); return result;
  }, { isolationLevel: 'Serializable', timeout: 30000 }); } catch (error) { throw mapSerializableConflict(error); }
}
async function authority(tx: Tx, session: AuthSession, proof?: UpdateCredentials) {
  const current = await updateActor(tx, session, proof);
  if (current.actor.role !== 'admin' || !recordUpdatePermission(current.actor, 'settings.manage')
    || !recordUpdatePermission(current.actor, 'user.read') || proof && !recordUpdatePermission(current.actor, 'user.write')) deny();
  return current;
}
async function lockCommand(tx: Tx, commandId: string) {
  await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text', 'admin-record:' + commandId);
}
async function journal(tx: Tx, current: Authority, input: { commandId: string; role: string; reason: string },
  requestHash: string, operation: 'UPDATE' | 'CLOSE', before: unknown, after: unknown) {
  const beforeHash = digest(before), afterHash = digest(after);
  const plain = (v: unknown) => v === null ? Prisma.JsonNull : JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
  await tx.adminRecordRevision.create({ data: { commandId: input.commandId, model: roleProfileModel, recordId: input.role,
    actorId: current.actor.id, sessionId: current.registry.id, requestHash, operation, beforeHash, afterHash,
    before: plain(before), after: plain(after), reason: input.reason } });
  await tx.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: current.actor.id,
    entityType: roleProfileModel, entityId: input.role, event: operation === 'CLOSE' ? 'admin_record_attempt_closed' : 'admin_record_changed',
    after: operation === 'CLOSE' ? { commandId: input.commandId } : { commandId: input.commandId, action: operation, beforeHash, afterHash,
      changedPaths: ['rolePreset'], existingAccountsChanged: false } } });
}
export async function readAdminRoleProfile(db: PrismaClient, session: AuthSession, rawRole: unknown, page = 1) {
  const role = profileRole.parse(rawRole);
  z.number().int().min(1).max(10000).parse(page);
  return transaction(db, async tx => {
    const current = await authority(tx, session), profile = await loadAdminRoleProfile(tx, role);
    await current.finish();
    return { role, current: profile.current!, version: profile.version, history: [...profile.history].reverse().slice((page - 1) * 50, page * 50),
      page, hasMore: profile.history.length > page * 50, canWrite: recordUpdatePermission(current.actor, 'user.write'), totalRevisions: profile.history.length };
  });
}
export async function saveAdminRoleProfile(db: PrismaClient, session: AuthSession, raw: unknown, proof: UpdateCredentials) {
  const input = roleProfileCommand.parse(raw), overrides = normalizeRoleProfile(input.role, input.overrides);
  const requestHash = digest({ protocol: 'ADMIN_ROLE_PROFILE_V1', input });
  return transaction(db, async tx => {
    const current = await authority(tx, session, proof); await lockCommand(tx, input.commandId);
    const previous = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (previous) {
      if (previous.model !== roleProfileModel || previous.recordId !== input.role || previous.actorId !== current.actor.id) return deny();
      if (previous.operation === 'CLOSE') throw new RoleProfileError('CLOSED');
      if (previous.requestHash !== requestHash) throw new RoleProfileError('STALE');
      await loadAdminRoleProfile(tx, input.role); await current.finish(); return { replayed: true };
    }
    const profile = await loadAdminRoleProfile(tx, input.role, true);
    if (profile.version !== input.expectedVersion) throw new RoleProfileError('STALE');
    if (digest(overrides) === digest(profile.current!.overrides)) throw new RoleProfileError('INVALID');
    await journal(tx, current, input, requestHash, 'UPDATE', profile.current,
      { ...profile.current!, revision: profile.current!.revision + 1, overrides });
    await current.finish(); return { replayed: false };
  });
}
export async function reconcileAdminRoleProfile(db: PrismaClient, session: AuthSession, raw: unknown) {
  const input = z.object({ commandId: z.string().uuid(), role: profileRole, close: z.boolean() }).strict().parse(raw);
  for (let attempt = 0; ; attempt++) {
    try { return await transaction(db, async tx => {
      const current = await authority(tx, session); await lockCommand(tx, input.commandId);
      await loadAdminRoleProfile(tx, input.role);
      const previous = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
      if (previous) {
        if (previous.model !== roleProfileModel || previous.recordId !== input.role || previous.actorId !== current.actor.id) return deny();
        await current.finish(); return { status: previous.operation === 'CLOSE' ? 'CLOSED' as const : 'RECORDED' as const };
      }
      if (!input.close) { await current.finish(); return { status: 'UNKNOWN' as const }; }
      await journal(tx, current, { ...input, reason: 'Chiusura esplicita del tentativo di modifica del profilo' },
        digest({ protocol: 'ADMIN_ROLE_PROFILE_CLOSE_V1', input }), 'CLOSE', null, null);
      await current.finish(); return { status: 'CLOSED' as const };
    }); } catch (error) { if (!(error instanceof SerializableConflictError) || attempt >= 2) throw error; }
  }
}
