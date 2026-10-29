import { timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { privilegedAccessMode } from './application-security-policy';
import { lockAuthoritativeInternalSession, tokenDigestFromCookie } from './internal-session-registry';
import { internalSessionMode } from './session';
import { verifyPrivilegedStepUpToken, type PrivilegedStepUpKey } from './privileged-step-up-token';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { acquireLeadIdentityWriteLock } from './lead-identity';
import { assertTechnicalPracticeOperational } from './client-operational-hold';
import { readCommercialOrigin } from './commercial-origin';
import { RecordUpdateError, resolveUpdateSelection, updatePreviewDigest } from './record-update-contract';
import { updateCommandSchema, type UpdateCommand } from './record-update-input';
import { projectRecordChange } from './record-update-projection';
import { recordUpdateContext, currentRecordUpdateUser, recordUpdatePermission, recordWritePermissions } from './record-update-context';
import { mapSerializableConflict } from './serializable';
import { recordUpdateEmailAuthority } from './record-update-email-authority';
import { assertProjectParametersCurrent } from './project-parameters-state';

type Tx = Prisma.TransactionClient;
export type UpdateCredentials = { key: PrivilegedStepUpKey; sessionToken: string; stepUpToken: string };
function deny(): never { throw new RecordUpdateError('DENIED'); }
function stale(): never { throw new RecordUpdateError('STALE'); }
async function clock(tx: Tx) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  return row.now;
}
export async function updateActor(tx: Tx, claimed: AuthSession, proof?: UpdateCredentials) {
  if (internalSessionMode() !== 'registry' || !claimed.sessionId || !claimed.active) deny();
  if (proof && (privilegedAccessMode() !== 'enforced' || !await lockRegisteredPrivilegedStepUpKey(tx, proof.key))) deny();
  await lockCommunicationDirectory(tx);
  const registry = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId });
  if (!registry || !registry.active || registry.deletedAt || registry.revokedAt) deny();
  const actor = await currentRecordUpdateUser(tx, registry.userId);
  if (!actor) deny();
  const finish = async () => {
    const now = await clock(tx);
    if (!Number.isFinite(claimed.expiresAt) || claimed.expiresAt * 1000 <= now.getTime() || registry.expiresAt <= now) deny();
    if (proof) {
      const digest = await tokenDigestFromCookie(proof.sessionToken);
      const row = await tx.internalSession.findUnique({ where: { id: registry.id }, select: { tokenDigest: true } });
      if (!digest || !row || digest.length !== row.tokenDigest.length || !timingSafeEqual(digest, row.tokenDigest)
        || !verifyPrivilegedStepUpToken({ key: proof.key, expectedUserId: actor.id, role: actor.role, sessionToken: proof.sessionToken,
          token: proof.stepUpToken, nowSeconds: Math.floor(now.getTime() / 1000) })) deny();
    }
    return now;
  };
  await finish();
  return { actor, registry, finish };
}
export async function updateDirectory(tx: Tx) {
  const rows = await tx.user.findMany({ orderBy: { id: 'asc' }, select: {
    id: true, name: true, email: true, role: true, active: true, deletedAt: true, recordUpdateEpoch: true,
  } });
  return rows.map(row => ({ id: row.id, name: row.name, email: row.email, role: row.role, active: row.active,
    deleted: Boolean(row.deletedAt), revision: String(row.recordUpdateEpoch) }));
}
async function proposal(tx: Tx, claimed: AuthSession, input: UpdateCommand, proof?: UpdateCredentials) {
  // Native key -> identity -> actor/context ordering. The key is retained until
  // the final proof check; the directory is shared with native account writers.
  if (proof && !await lockRegisteredPrivilegedStepUpKey(tx, proof.key)) deny();
  if (input.kind === 'LEAD' && input.operation === 'UPDATE') await acquireLeadIdentityWriteLock(tx);
  const auth = await updateActor(tx, claimed, proof);
  if (auth.actor.role !== 'admin') deny();
  const mode = input.operation === 'REVOKE' ? 'CRM' : input.mode ?? 'CRM';
  const emailAuthority = mode === 'CRM' ? null : await recordUpdateEmailAuthority(tx, auth.actor);
  if (mode !== 'CRM' && !emailAuthority) deny();
  const context = await recordUpdateContext(tx, input.kind, input.recordId, Boolean(proof));
  if (!context.canRead(auth.actor)) deny();
  if (context.version.toISOString() !== input.expectedVersion) stale();
  if (input.patch?.kind === 'PROJECT' && input.patch.parameters) {
    if (context.patch.kind !== 'PROJECT' || !context.patch.parameters) deny();
    assertProjectParametersCurrent(input.patch.parameters, context.patch.parameters);
  }
  const rule = await tx.recordUpdateRule.findUnique({ where: { kind_recordId: { kind: input.kind, recordId: input.recordId } } });
  if ((rule?.version ?? 0) !== input.ruleVersion) stale();
  const now = await clock(tx);
  if (input.expiresAt && (new Date(input.expiresAt) <= now || new Date(input.expiresAt).getTime() > now.getTime() + 366 * 86400_000)) stale();
  if (input.operation === 'REVOKE' && (!rule || !rule.active)) stale();
  const directory = await updateDirectory(tx);
  const resolved = input.operation === 'REVOKE' ? null : resolveUpdateSelection(input.selection, directory);
  const admissions = [];
  for (const person of resolved?.people ?? []) {
    const user = await currentRecordUpdateUser(tx, person.id);
    const available = Boolean(user && context.canRead(user)
      && (mode === 'CRM' || recordUpdatePermission(user, 'practice_communications.read')));
    admissions.push({ ...person, available, reason: available ? 'AVAILABLE' : 'NO_CURRENT_ACCESS',
      communication: Boolean(available && user && recordUpdatePermission(user, 'practice_communications.read')) });
  }
  const recipients = admissions.filter(person => person.available).map(person => ({
    id: person.id, epoch: Number(person.revision), communication: person.communication,
  }));
  if (input.operation !== 'REVOKE' && recipients.length === 0) deny();
  const summaries = input.patch ? projectRecordChange(input.kind, context.patch, input.patch).summaries : [];
  if (input.operation === 'UPDATE') {
    if (!recordUpdatePermission(auth.actor, recordWritePermissions[input.kind]) || !summaries.length) deny();
    if (input.patch?.kind === 'PRACTICE' && summaries.some(s => s.event === 'STATE_CHANGED' || s.event === 'NEXT_ACTION')
      && !recordUpdatePermission(auth.actor, 'technical.status')) deny();
  }
  const digest = updatePreviewDigest({ actorId: auth.actor.id, sessionId: auth.registry.id, kind: input.kind, recordId: input.recordId,
    recordVersion: context.version.toISOString(), scopeEpoch: context.scopeDigest, directoryBinding: resolved?.directoryBinding ?? canonicalSha256({ id: rule?.id ?? null, version: rule?.version ?? 0, active: rule?.active ?? false }),
    recipientAccessBinding: canonicalSha256(emailAuthority ? { recipients, emailAuthorityRevision: emailAuthority.revision } : recipients), patchDigest: canonicalSha256(input), selection: resolved?.selection ?? { people: [auth.actor.id], groups: [] },
    events: input.events, mode, persistent: input.persistent || input.operation === 'RULE', ruleVersion: input.ruleVersion, commandId: input.commandId });
  await auth.finish();
  return { input, auth, context, rule, resolved, admissions, recipients, summaries, digest, now, mode, emailAuthority };
}
const transaction = async <T>(db: PrismaClient, callback: (tx: Tx) => Promise<T>) => {
  try { return await db.$transaction(callback, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }); }
  catch (error) { throw mapSerializableConflict(error); }
};
export async function previewRecordUpdate(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = updateCommandSchema.parse(raw);
  return transaction(db, async tx => {
    const p = await proposal(tx, claimed, input);
    return { digest: p.digest, label: p.context.label, people: p.admissions.map(({ id, name, email, available, reason, communication }) =>
      ({ id, name, email, available, reason, communication })), summaries: p.summaries, operation: input.operation,
      persistent: input.persistent || input.operation === 'RULE', events: input.events, expiresAt: input.expiresAt, mode: p.mode };
  });
}
export async function confirmRecordUpdate(db: PrismaClient, claimed: AuthSession, raw: unknown, digest: string, proof: UpdateCredentials) {
  const input = updateCommandSchema.parse(raw);
  if (!/^[a-f0-9]{64}$/.test(digest)) deny();
  const commandDigest = canonicalSha256({ input, digest });
  return transaction(db, async tx => {
    if (!await lockRegisteredPrivilegedStepUpKey(tx, proof.key)) deny();
    if (input.kind === 'LEAD' && input.operation === 'UPDATE') await acquireLeadIdentityWriteLock(tx);
    const auth = await updateActor(tx, claimed, proof);
    if (auth.actor.role !== 'admin') deny();
    const old = await tx.recordUpdateCommand.findUnique({ where: { id: input.commandId } });
    if (old) {
      if (old.actorId !== auth.actor.id || old.digest !== commandDigest) stale();
      await auth.finish();
      return { commandId: old.id, confirmed: true, replayed: true };
    }
    const p = await proposal(tx, claimed, input, proof);
    if (p.digest !== digest) stale();
    const [transactionRow] = await tx.$queryRaw<Array<{ id: bigint }>>`SELECT txid_current() AS id`;
    await tx.recordUpdateCommand.create({ data: {
      id: input.commandId, actorId: p.auth.actor.id, actorEpoch: p.auth.actor.recordUpdateEpoch,
      kind: input.kind, recordId: input.recordId, digest: commandDigest, operation: input.operation,
      mode: p.mode, emailAuthorityRevision: p.emailAuthority?.revision ?? null,
      scope: p.context.scope as Prisma.InputJsonValue, selection: input.selection, directoryBinding: p.resolved?.directoryBinding ?? digest,
      recipients: p.recipients, transactionId: transactionRow.id, createdAt: p.now,
    } });
    if (input.operation === 'REVOKE') {
      await tx.recordUpdateRule.update({ where: { id: p.rule!.id, version: input.ruleVersion }, data: { active: false, version: { increment: 1 }, updatedAt: p.now } });
    } else if (input.operation === 'RULE' || input.persistent) {
      const data = { kind: input.kind, recordId: input.recordId, active: true, version: input.ruleVersion + 1,
        mode: p.mode, emailAuthorityRevision: p.emailAuthority?.revision ?? null,
        authorId: p.auth.actor.id, authorEpoch: p.auth.actor.recordUpdateEpoch, scope: p.context.scope as Prisma.InputJsonValue,
        selection: p.resolved!.selection, directoryBinding: p.resolved!.directoryBinding, recipients: p.recipients,
        events: [...new Set(input.events)], expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, updatedAt: p.now };
      if (p.rule) await tx.recordUpdateRule.update({ where: { id: p.rule.id, version: input.ruleVersion }, data });
      else await tx.recordUpdateRule.create({ data: { ...data, createdAt: p.now } });
    }
    if (input.operation === 'UPDATE' && input.patch) {
      await tx.$queryRaw`SELECT set_config('fai.record_update_command',${input.commandId},true)`;
      const updatedAt = new Date(Math.max(p.now.getTime(), p.context.version.getTime() + 1));
      const where = { id: input.recordId, updatedAt: p.context.version };
      const patch = input.patch;
      const date = (value: string) => value ? new Date(value) : null;
      switch (patch.kind) {
        case 'LEAD':
          await tx.lead.update({ where, data: { nextActionDate: date(patch.nextActionDate), nextAction: date(patch.nextActionDate),
            nextActionNote: patch.nextActionNote || null, updatedAt } });
          break;
        case 'CLIENT':
          await tx.client.update({ where, data: { displayName: patch.displayName, type: patch.type, updatedAt } });
          break;
        case 'PROJECT': {
          const parameters = patch.parameters;
          if (parameters) for (const row of parameters.expenses) {
            const data = { category: row.category, description: row.description, amount: new Prisma.Decimal(row.amount), estimated: row.estimated };
            if (row.id) await tx.projectExpense.update({ where: { id: row.id, projectId: input.recordId }, data });
            else await tx.projectExpense.create({ data: { ...data, projectId: input.recordId } });
          }
          await tx.project.update({ where, data: { title: patch.title, status: patch.status, updatedAt,
            ...(parameters ? { description: parameters.description || null,
              totalInvestment: parameters.totalInvestment ? new Prisma.Decimal(parameters.totalInvestment) : null,
              requestedAmount: parameters.requestedAmount ? new Prisma.Decimal(parameters.requestedAmount) : null } : {}) } });
          // Native title/status triggers already record those events. A parameters-only
          // change uses the same queue/function, without financial values or free text.
          if (parameters && p.context.patch.kind === 'PROJECT' && patch.title === p.context.patch.title
            && p.summaries.some(summary => summary.event === 'RECORD_CHANGED' && summary.changed.includes('profile')))
            await tx.$executeRaw`SELECT fai_record_update_record('PROJECT',${input.recordId},'RECORD_CHANGED','["profile"]'::jsonb,${'project-parameters:' + input.commandId})`;
          break;
        }
        case 'PRACTICE':
          await assertTechnicalPracticeOperational(tx, [p.context.clientId!], patch.status);
          await tx.technicalPractice.update({ where, data: { status: patch.status, clientVisibleStatus: patch.clientVisibleStatus || null,
            dueDate: date(patch.dueDate), nextClientUpdateAt: date(patch.nextClientUpdateAt), updatedAt } });
          break;
      }
    }
    await tx.auditLog.create({ data: { actorId: p.auth.actor.id, entityType: 'RecordUpdateCommand', entityId: input.commandId,
      event: 'record_update_confirmed', after: { operation: input.operation, kind: input.kind,
        recipients: p.recipients.length, events: input.events, persistent: input.persistent || input.operation === 'RULE', channel: p.mode,
        changed: p.summaries, proof: digest } } });
    await p.auth.finish();
    return { commandId: input.commandId, confirmed: true, replayed: false };
  });
}
export async function readRecordUpdateSetup(db: PrismaClient, claimed: AuthSession, kind: UpdateCommand['kind'], id: string) {
  return transaction(db, async tx => {
    const auth = await updateActor(tx, claimed);
    if (auth.actor.role !== 'admin') deny();
    const context = await recordUpdateContext(tx, kind, id);
    if (!context.canRead(auth.actor)) deny();
    const rule = await tx.recordUpdateRule.findUnique({ where: { kind_recordId: { kind, recordId: id } } });
    const directory = await updateDirectory(tx);
    let ruleCurrent = false;
    if (rule?.active && rule.authorId === auth.actor.id && rule.authorEpoch === auth.actor.recordUpdateEpoch
      && canonicalSha256(rule.scope) === context.scopeDigest && (!rule.expiresAt || rule.expiresAt > await clock(tx))) {
      try { ruleCurrent = resolveUpdateSelection(rule.selection, directory).directoryBinding === rule.directoryBinding; } catch { /* requires reconfirmation */ }
    }
    const origin = context.clientId && recordUpdatePermission(auth.actor, 'client.read') ? await readCommercialOrigin(tx, context.clientId) : null;
    const emailAuthority = await recordUpdateEmailAuthority(tx, auth.actor);
    if (rule?.mode !== 'CRM' && rule?.emailAuthorityRevision !== emailAuthority?.revision) ruleCurrent = false;
    await auth.finish();
    return { kind, id, label: context.label, href: context.href, expectedVersion: context.version.toISOString(), patch: context.patch,
      emailDraftsAvailable: kind !== 'PROJECT' && Boolean(emailAuthority),
      rule: rule ? { version: rule.version, active: rule.active, current: ruleCurrent, selection: rule.selection,
        events: rule.events, expiresAt: rule.expiresAt?.toISOString() ?? null, mode: rule.mode } : null,
      people: directory.filter(person => person.active && !person.deleted).map(({ id, name, email, role }) => ({ id, name, email, role })),
      originatorId: origin?.snapshot.contractedById ?? null };
  });
}
export async function readRecordUpdateReceipt(db: PrismaClient, claimed: AuthSession, commandId: string) {
  return transaction(db, async tx => {
    const auth = await updateActor(tx, claimed);
    const row = await tx.recordUpdateCommand.findFirst({ where: { id: commandId, actorId: auth.actor.id }, select: { id: true } });
    await auth.finish();
    return { confirmed: Boolean(row), commandId };
  });
}
