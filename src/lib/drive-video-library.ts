import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import type { UpdateCredentials } from './record-updates';
import { canonicalSha256 as hash } from './canonical-json';
import { mapSerializableConflict } from './serializable';
import { currentVideoActor, currentVideoDirectory, VideoLibraryError } from './video-library';
import { canReadPublishedVideo, resolveVideoAudience, type VideoPerson } from './video-access-policy';
import { isTechnicalAccount } from './technical-confidentiality';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { createVideoDecision, verifyVideoDecision } from './video-decision';
import { driveVideoCommand, driveVideoModel, driveVideoSnapshot, type DriveVideoCommand, type DriveVideoSnapshot } from './drive-video-contract';

type Tx = Prisma.TransactionClient;
type Authority = Awaited<ReturnType<typeof currentVideoActor>>;
function deny(): never { throw new VideoLibraryError('DENIED'); }
function stale(): never { throw new VideoLibraryError('STALE'); }
async function transaction<T>(db: PrismaClient, work: (tx: Tx) => Promise<T>) {
  try { return await db.$transaction(async tx => {
    const result = await work(tx);
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return result;
  }, { isolationLevel: 'Serializable', timeout: 30000 }); } catch (error) { throw mapSerializableConflict(error); }
}
async function lock(tx: Tx, key: string, write = true) {
  await tx.$queryRawUnsafe(write ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text'
    : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))::text', key);
}
/** Immutable typed revisions use the existing native Admin journal and audit
 * constraint. A Drive reference is never a fake VideoAsset or a local file. */
async function load(tx: Tx, id: string, write = false) {
  z.string().uuid().parse(id);
  await lock(tx, 'drive-video:' + id, write);
  const rows = await tx.adminRecordRevision.findMany({ where: { model: driveVideoModel, recordId: id, operation: { not: 'CLOSE' } } });
  const history = rows.map(row => {
    const before = row.before === null ? null : driveVideoSnapshot.parse(row.before), after = driveVideoSnapshot.parse(row.after);
    if (after.id !== id || before && before.id !== id || hash(before) !== row.beforeHash || hash(after) !== row.afterHash
      || row.operation !== (before ? 'UPDATE' : 'CREATE') || after.revision !== (before?.revision ?? 0) + 1
      || after.state === 'PUBLISHED' && (after.publisherId !== row.actorId || !after.publisherEpoch)
      || after.state !== 'PUBLISHED' && (after.publisherId !== null || after.publisherEpoch !== null || after.audience.length)) deny();
    return { commandId: row.commandId, actorId: row.actorId, operation: row.operation, createdAt: row.createdAt.toISOString(), before, after };
  }).sort((a, b) => a.after.revision - b.after.revision);
  let current: DriveVideoSnapshot | null = null;
  for (const row of history) {
    if (hash(current) !== hash(row.before)) deny();
    current = row.after;
  }
  return { current, history };
}
async function journal(tx: Tx, auth: Authority, input: DriveVideoCommand, before: DriveVideoSnapshot | null, after: DriveVideoSnapshot | null, closing = false) {
  const operation = closing ? 'CLOSE' : before ? 'UPDATE' : 'CREATE';
  const beforeHash = hash(before), afterHash = hash(after);
  const plain = (value: DriveVideoSnapshot | null) => value === null ? Prisma.JsonNull : JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  await tx.adminRecordRevision.create({ data: { commandId: input.commandId, model: driveVideoModel, recordId: input.videoId,
    actorId: auth.person.id, sessionId: auth.registry.id, requestHash: hash(input), operation, beforeHash, afterHash,
    before: plain(before), after: plain(after), reason: 'Google Drive · ' + input.operation } });
  await tx.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: auth.person.id,
    entityType: driveVideoModel, entityId: input.videoId, event: closing ? 'admin_record_attempt_closed' : 'admin_record_changed',
    after: closing ? { commandId: input.commandId } : { commandId: input.commandId, action: operation, beforeHash, afterHash,
      source: 'GOOGLE_DRIVE_REFERENCE', transition: input.operation, revision: after!.revision, recipients: after!.audience.length } } });
}
async function proposal(tx: Tx, claimed: AuthSession, input: DriveVideoCommand, proof?: UpdateCredentials) {
  const auth = await currentVideoActor(tx, claimed, true, proof), { current } = await load(tx, input.videoId, Boolean(proof));
  if ((current?.revision ?? 0) !== input.expectedVersion || !current && input.operation !== 'SAVE_DRAFT'
    || current?.state === 'ARCHIVED' && input.operation !== 'RESTORE_DRAFT'
    || current?.state !== 'ARCHIVED' && input.operation === 'RESTORE_DRAFT') stale();
  const details = 'details' in input ? input.details : current!.details;
  // Replacing the linked file first withdraws the existing publication.
  if (input.operation === 'PUBLISH' && current?.details.url !== details.url) stale();
  const directory = await currentVideoDirectory(tx);
  const selected = 'details' in input && (details.selection.people.length || details.selection.areas.length)
    ? resolveVideoAudience(details.selection, directory) : null;
  const now = await auth.finish(), expiry = details.expiresAt ? new Date(details.expiresAt) : null;
  if (input.operation === 'PUBLISH') {
    if (!selected || expiry && expiry <= now) deny();
    if (selected.audience.some(member => isTechnicalAccount(directory.find(p => p.id === member.id)!))
      && details.selection.technicalContentReviewed !== true) throw new VideoLibraryError('CONTENT_REVIEW_REQUIRED');
  }
  const digest = hash({ input, before: current, actor: auth.person.id, epoch: auth.person.epoch,
    session: auth.registry.id, directory: selected?.binding ?? null });
  return { auth, current, details, selected, digest, expiry };
}
export async function previewDriveVideo(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = driveVideoCommand.parse(raw), key = await loadActivePrivilegedStepUpKey(db);
  if (!key) deny();
  return transaction(db, async tx => {
    const p = await proposal(tx, claimed, input), now = await p.auth.finish();
    return { digest: createVideoDecision(key, { actorId: p.auth.person.id, actorEpoch: p.auth.person.epoch, sessionId: p.auth.registry.id }, input, p.digest, now),
      title: p.details.title, url: p.details.url, people: p.selected?.people ?? [], expiresAt: p.details.expiresAt };
  });
}
export async function confirmDriveVideo(db: PrismaClient, claimed: AuthSession, raw: unknown, token: string, proof: UpdateCredentials) {
  const input = driveVideoCommand.parse(raw);
  return transaction(db, async tx => {
    const auth = await currentVideoActor(tx, claimed, true, proof);
    await lock(tx, 'admin-record:' + input.commandId);
    const receipt = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (receipt) {
      if (receipt.actorId !== auth.person.id || receipt.sessionId !== auth.registry.id || receipt.model !== driveVideoModel
        || receipt.recordId !== input.videoId || receipt.requestHash !== hash(input)) deny();
      if (receipt.operation === 'CLOSE') throw new VideoLibraryError('CLOSED');
      await load(tx, input.videoId); await auth.finish(); return { confirmed: true, closed: false };
    }
    const p = await proposal(tx, claimed, input, proof);
    const identity = { actorId: auth.person.id, actorEpoch: auth.person.epoch, sessionId: auth.registry.id };
    const now = await auth.finish(), claims = verifyVideoDecision(proof.key, identity, input, token, now);
    if (claims.decisionHash !== p.digest) stale();
    const published = input.operation === 'PUBLISH';
    const after = driveVideoSnapshot.parse({ id: input.videoId, revision: (p.current?.revision ?? 0) + 1,
      state: published ? 'PUBLISHED' : input.operation === 'ARCHIVE' ? 'ARCHIVED' : 'DRAFT',
      details: p.details, audience: published ? p.selected!.audience : [],
      publisherId: published ? auth.person.id : null, publisherEpoch: published ? auth.person.epoch : null, updatedAt: now.toISOString() });
    await journal(tx, auth, input, p.current, after);
    const end = await auth.finish();
    verifyVideoDecision(proof.key, identity, input, token, end);
    if (published && p.expiry && p.expiry <= end) deny();
    return { confirmed: true, closed: false };
  });
}
/** Serialize with the attempted command. Absence becomes a terminal closure,
 * never permission to resend an unseen mutation with a new command ID. */
export async function settleDriveVideo(db: PrismaClient, claimed: AuthSession, raw: unknown, token: string) {
  const input = driveVideoCommand.parse(raw), key = await loadActivePrivilegedStepUpKey(db);
  if (!key) deny();
  return transaction(db, async tx => {
    const auth = await currentVideoActor(tx, claimed, true);
    verifyVideoDecision(key, { actorId: auth.person.id, actorEpoch: auth.person.epoch, sessionId: auth.registry.id },
      input, token, await auth.finish(), { closing: true });
    await lock(tx, 'admin-record:' + input.commandId);
    const row = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (row && (row.actorId !== auth.person.id || row.sessionId !== auth.registry.id || row.model !== driveVideoModel
      || row.recordId !== input.videoId || row.requestHash !== hash(input))) deny();
    if (!row) await journal(tx, auth, input, null, null, true);
    else if (row.operation !== 'CLOSE') await load(tx, input.videoId);
    await auth.finish(); return { confirmed: Boolean(row && row.operation !== 'CLOSE'), closed: !row || row.operation === 'CLOSE' };
  });
}
function allowed(row: DriveVideoSnapshot, person: VideoPerson, directory: VideoPerson[], now: Date) {
  return canReadPublishedVideo({ state: row.state, fileReady: true, expiresAt: row.details.expiresAt ? new Date(row.details.expiresAt) : null,
    authorId: row.publisherId, authorEpoch: row.publisherEpoch, audience: row.audience, downloadAllowed: false,
    technicalContentReviewed: row.details.selection.technicalContentReviewed }, person,
  directory.find(p => p.id === row.publisherId) ?? null, now);
}
const view = (row: DriveVideoSnapshot) => ({ id: row.id, version: row.revision, state: row.state, title: row.details.title,
  description: row.details.description, category: row.details.category, position: row.details.position,
  url: row.details.url, expiresAt: row.details.expiresAt });
export async function readDriveVideo(db: PrismaClient, claimed: AuthSession, id: string, manage = false) {
  return transaction(db, async tx => {
    const auth = await currentVideoActor(tx, claimed, manage), loaded = await load(tx, id), row = loaded.current;
    if (!row) deny();
    const directory = await currentVideoDirectory(tx);
    if (!manage && !allowed(row, auth.person, directory, await auth.finish())) deny();
    const end = await auth.finish();
    if (!manage && !allowed(row, auth.person, directory, end)) deny();
    return view(row);
  });
}
export async function driveVideoSetup(db: PrismaClient, claimed: AuthSession, id: string) {
  return transaction(db, async tx => {
    const auth = await currentVideoActor(tx, claimed, true), loaded = await load(tx, id), directory = await currentVideoDirectory(tx);
    await auth.finish();
    return { id, current: loaded.current, history: loaded.history.map(r => ({ commandId: r.commandId, actorId: r.actorId,
      createdAt: r.createdAt, revision: r.after.revision, state: r.after.state })),
    people: directory.filter(p => p.active && !p.deleted && p.canRead).map(({ id, name, email, role }) => ({ id, name, email, role })) };
  });
}
export async function listDriveVideos(db: PrismaClient, claimed: AuthSession, query = '', manage = false) {
  const search = z.string().max(160).parse(query).trim().toLocaleLowerCase('it-IT');
  return transaction(db, async tx => {
    const auth = await currentVideoActor(tx, claimed, manage), directory = await currentVideoDirectory(tx);
    const ids = await tx.adminRecordRevision.findMany({ where: { model: driveVideoModel, operation: 'CREATE' }, select: { recordId: true } });
    const rows: DriveVideoSnapshot[] = [];
    for (const { recordId } of ids) {
      const row = (await load(tx, recordId)).current;
      if (row && (manage || allowed(row, auth.person, directory, await auth.finish()))
        && (!search || [row.details.title, row.details.description, row.details.category].some(v => v.toLocaleLowerCase('it-IT').includes(search)))) rows.push(row);
    }
    const now = await auth.finish();
    return rows.filter(row => manage || allowed(row, auth.person, directory, now)).map(view).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  });
}
