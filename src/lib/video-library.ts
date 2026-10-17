import { Prisma, type PrismaClient, type VideoEntry, type VideoAsset } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { recordUpdatePermission } from './record-update-context';
import { updateActor, type UpdateCredentials } from './record-updates';
import { RecordUpdateError } from './record-update-contract';
import { mapSerializableConflict } from './serializable';
import { canReadPublishedVideo, canDownloadPublishedVideo, resolveVideoAudience, type VideoPerson, type VideoPublication } from './video-access-policy';
import { videoCommandSchema, videoDetailsSchema, type VideoCommand, type VideoDetails } from './video-input';
import { prepareVideoFile, savePrivateVideoFile, readPrivateVideoFile, videoStoragePath } from './video-storage';
import { videoLibraryQuotaBytes } from './video-file-contract';

type Tx = Prisma.TransactionClient;
type Proof = UpdateCredentials;
const transactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 } as const;
const uuid = z.string().uuid();
export class VideoLibraryError extends Error {
  constructor(public readonly code: 'DENIED' | 'STALE' | 'QUOTA' | 'UNAVAILABLE') { super('VIDEO_' + code); }
}
function denied(): never { throw new VideoLibraryError('DENIED'); }
function stale(): never { throw new VideoLibraryError('STALE'); }
async function transaction<T>(db: PrismaClient, run: (tx: Tx) => Promise<T>) {
  try { return await db.$transaction(run, transactionOptions); } catch (error) { throw mapSerializableConflict(error); }
}
const userSelection = { id: true, name: true, role: true, active: true, deletedAt: true, recordUpdateEpoch: true,
  permissionOverrides: { select: { permission: true, allowed: true } } } as const;
type CurrentPerson = Prisma.UserGetPayload<{ select: typeof userSelection }>;
function person(row: CurrentPerson): VideoPerson {
  return { id: row.id, name: row.name, role: row.role, active: row.active, deleted: Boolean(row.deletedAt),
    epoch: row.recordUpdateEpoch, canRead: recordUpdatePermission(row, 'video.read'),
    canManage: row.role === 'admin' && recordUpdatePermission(row, 'video.manage') };
}
async function directory(tx: Tx) {
  return (await tx.user.findMany({ select: userSelection, orderBy: { id: 'asc' } })).map(person);
}
async function actor(tx: Tx, claimed: AuthSession, manage = false, proof?: Proof) {
  let auth;
  try { auth = await updateActor(tx, claimed, proof); }
  catch (error) { if (error instanceof RecordUpdateError && error.code === 'DENIED') denied(); throw error; }
  const current = person(auth.actor);
  if (!current.canRead || (manage && !current.canManage)) denied();
  return { ...auth, person: current };
}
async function entry(tx: Tx, id: string, write = false) {
  uuid.parse(id);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "VideoEntry" WHERE id=${id}::uuid ${Prisma.raw(write ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const row = await tx.videoEntry.findUnique({ where: { id } });
  if (!row) denied();
  return row;
}
async function readyFile(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "VideoAsset" WHERE id=${id}::uuid FOR SHARE`;
  const file = await tx.videoAsset.findUnique({ where: { id } });
  if (!file || file.state !== 'READY') denied();
  videoStoragePath(file.id);
  return file;
}
const audienceSchema = z.array(z.object({ id: z.string().min(1).max(128), epoch: z.number().int().positive(), role: z.string() }).strict()).max(100);
function publication(row: VideoEntry, file: VideoAsset): VideoPublication {
  const audience = audienceSchema.parse(row.audience);
  if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(row.state) || new Set(audience.map(item => item.id)).size !== audience.length) denied();
  return { state: row.state as VideoPublication['state'], fileReady: file.state === 'READY', expiresAt: row.expiresAt,
    authorId: row.publishedById, authorEpoch: row.publisherEpoch, audience, downloadAllowed: row.downloadAllowed };
}
function details(row: VideoEntry): VideoDetails {
  return videoDetailsSchema.parse({ fileId: row.fileId, title: row.title, description: row.description, category: row.category,
    position: row.position, selection: row.selection, downloadAllowed: row.downloadAllowed, expiresAt: row.expiresAt?.toISOString() ?? null });
}
function item(row: VideoEntry, file: VideoAsset) {
  return { id: row.id, version: row.version, title: row.title, description: row.description, category: row.category,
    position: row.position, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes,
    downloadAllowed: row.downloadAllowed, expiresAt: row.expiresAt?.toISOString() ?? null };
}
async function history(tx: Tx, row: VideoEntry, command: { id: string; operation: string; digest: string }, current: VideoPerson) {
  const [clock] = await tx.$queryRaw<Array<{ id: bigint }>>`SELECT txid_current() AS id`;
  await tx.videoCommand.create({ data: { id: command.id, videoId: row.id, version: row.version, operation: command.operation,
    digest: command.digest, actorId: current.id, actorEpoch: current.epoch, transactionId: clock.id } });
  // DB-native snapshot preserves timestamp precision and the complete immutable revision.
  await tx.$executeRaw`INSERT INTO "VideoRevision" ("videoId","version","snapshot","actorId")
    SELECT id, version, to_jsonb(v), ${current.id} FROM "VideoEntry" v WHERE id=${row.id}::uuid`;
  await tx.auditLog.create({ data: { actorId: current.id, event: 'VIDEO_LIBRARY_MUTATION', entityType: 'VideoEntry', entityId: row.id,
    after: { commandId: command.id, operation: command.operation, version: row.version,
      recipients: audienceSchema.parse(row.audience).length, downloadAllowed: row.downloadAllowed } } });
}

/** File IO is bounded and private. Quota is reserved before any write. A lost
 * response is reconciled with the original upload command, never a new upload. */
export async function uploadVideo(db: PrismaClient, claimed: AuthSession, commandId: string, file: File, proof: Proof) {
  uuid.parse(commandId); videoStoragePath(commandId);
  await transaction(db, async tx => { const auth = await actor(tx, claimed, true, proof); await auth.finish(); });
  const prepared = await prepareVideoFile(file);
  const reserved = await transaction(db, async tx => {
    const auth = await actor(tx, claimed, true, proof);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('FAI_VIDEO_LIBRARY_QUOTA_V1',0))`;
    const old = await tx.videoAsset.findUnique({ where: { id: commandId } });
    if (old) {
      if (old.ownerId !== auth.person.id || old.ownerEpoch !== auth.person.epoch || old.fileName !== prepared.fileName
        || old.mimeType !== prepared.mimeType || old.sizeBytes !== prepared.sizeBytes || old.sha256 !== prepared.sha256) stale();
    } else {
      const used = await tx.videoAsset.aggregate({ _sum: { sizeBytes: true } });
      if ((used._sum.sizeBytes ?? 0) + prepared.sizeBytes > videoLibraryQuotaBytes) throw new VideoLibraryError('QUOTA');
      await tx.videoAsset.create({ data: { id: commandId, ownerId: auth.person.id, ownerEpoch: auth.person.epoch,
        fileName: prepared.fileName, mimeType: prepared.mimeType, sizeBytes: prepared.sizeBytes, sha256: prepared.sha256 } });
    }
    await auth.finish(); return { owner: auth.person.id, epoch: auth.person.epoch };
  });
  await savePrivateVideoFile(commandId, prepared);
  return transaction(db, async tx => {
    const auth = await actor(tx, claimed, true, proof);
    if (auth.person.id !== reserved.owner || auth.person.epoch !== reserved.epoch) denied();
    await tx.$queryRaw`SELECT id FROM "VideoAsset" WHERE id=${commandId}::uuid FOR UPDATE`;
    const asset = await tx.videoAsset.findUniqueOrThrow({ where: { id: commandId } });
    if (asset.ownerId !== auth.person.id || asset.ownerEpoch !== auth.person.epoch || asset.sha256 !== prepared.sha256) stale();
    await readPrivateVideoFile(asset.id, asset);
    const oldCommand = await tx.videoCommand.findUnique({ where: { id: commandId } });
    if (oldCommand) {
      if (oldCommand.actorId !== auth.person.id || oldCommand.actorEpoch !== auth.person.epoch || oldCommand.operation !== 'UPLOAD') stale();
      await auth.finish(); return { confirmed: true, videoId: oldCommand.videoId };
    }
    const now = await auth.finish();
    if (asset.state !== 'RESERVED') stale();
    await tx.videoAsset.update({ where: { id: asset.id }, data: { state: 'READY', readyAt: now } });
    const row = await tx.videoEntry.create({ data: { id: commandId, fileId: asset.id, title: asset.fileName.slice(0, 160),
      description: '', category: '', position: 0, selection: { people: [], areas: [] }, audience: [],
      directoryBinding: canonicalSha256([]), createdById: auth.person.id, updatedAt: now } });
    await history(tx, row, { id: commandId, operation: 'UPLOAD', digest: canonicalSha256({ fileId: asset.id, sha256: asset.sha256,
      actorId: auth.person.id, actorEpoch: auth.person.epoch }) }, auth.person);
    await auth.finish(); return { confirmed: true, videoId: row.id };
  });
}

async function proposal(tx: Tx, claimed: AuthSession, input: VideoCommand, proof?: Proof) {
  const auth = await actor(tx, claimed, true, proof), row = await entry(tx, input.videoId, Boolean(proof));
  if (row.version !== input.expectedVersion || (row.state === 'ARCHIVED' && input.operation !== 'RESTORE_DRAFT')
    || (row.state !== 'ARCHIVED' && input.operation === 'RESTORE_DRAFT')) stale();
  const next = 'details' in input ? input.details : details(row);
  // Replacing an upload is a separate draft: an old approval never follows a new file.
  if (next.fileId !== row.fileId) stale();
  const file = await readyFile(tx, next.fileId), people = await directory(tx);
  const changesDetails = 'details' in input;
  const resolved = changesDetails && (next.selection.people.length || next.selection.areas.length)
    ? resolveVideoAudience(next.selection, people) : null;
  const now = await auth.finish(), expiresAt = next.expiresAt ? new Date(next.expiresAt) : null;
  if (input.operation === 'PUBLISH' && (!resolved || (expiresAt && expiresAt <= now))) denied();
  // Revocation and restoration to a private draft must remain possible even
  // when an old recipient or the stored bytes are no longer available.
  if (changesDetails) await readPrivateVideoFile(file.id, file);
  const digest = canonicalSha256({ protocol: 'VIDEO_DECISION_V1', input, actor: { id: auth.person.id, epoch: auth.person.epoch },
    session: auth.registry.id, current: { version: row.version, state: row.state }, file: { id: file.id, sha256: file.sha256, sizeBytes: file.sizeBytes },
    directory: resolved?.binding ?? canonicalSha256([]), audience: resolved?.audience ?? [] });
  return { auth, row, next, file, resolved, digest, expiresAt };
}
export async function previewVideo(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = videoCommandSchema.parse(raw);
  return transaction(db, async tx => {
    const p = await proposal(tx, claimed, input);
    const now = await p.auth.finish();
    if (input.operation === 'PUBLISH' && p.expiresAt && p.expiresAt <= now) denied();
    return { digest: p.digest, title: p.next.title, fileName: p.file.fileName, people: p.resolved?.people ?? [],
      downloadAllowed: input.operation === 'PUBLISH' && p.next.downloadAllowed,
      expiresAt: input.operation === 'PUBLISH' ? p.next.expiresAt : null };
  });
}
export async function confirmVideo(db: PrismaClient, claimed: AuthSession, raw: unknown, digest: string, proof: Proof) {
  const input = videoCommandSchema.parse(raw);
  z.string().regex(/^[a-f0-9]{64}$/).parse(digest);
  return transaction(db, async tx => {
    const p = await proposal(tx, claimed, input, proof);
    if (p.digest !== digest) stale();
    if (await tx.videoCommand.findUnique({ where: { id: input.commandId } })) stale();
    const now = await p.auth.finish(), publish = input.operation === 'PUBLISH';
    if (publish && p.expiresAt && p.expiresAt <= now) denied();
    const state = publish ? 'PUBLISHED' : input.operation === 'ARCHIVE' ? 'ARCHIVED' : 'DRAFT';
    const row = await tx.videoEntry.update({ where: { id: p.row.id, version: input.expectedVersion }, data: {
      version: { increment: 1 }, state, title: p.next.title, description: p.next.description, category: p.next.category,
      position: p.next.position, selection: p.next.selection, audience: publish ? p.resolved!.audience : [],
      directoryBinding: p.resolved?.binding ?? canonicalSha256([]), publishedById: publish ? p.auth.person.id : null,
      publisherEpoch: publish ? p.auth.person.epoch : null, downloadAllowed: publish && p.next.downloadAllowed,
      expiresAt: publish ? p.expiresAt : null, updatedAt: now,
    } });
    await history(tx, row, { id: input.commandId, operation: input.operation, digest }, p.auth.person);
    const end = await p.auth.finish();
    if (publish && p.expiresAt && p.expiresAt <= end) denied();
    return { confirmed: true };
  });
}
export async function readVideoReceipt(db: PrismaClient, claimed: AuthSession, commandId: string) {
  uuid.parse(commandId);
  return transaction(db, async tx => {
    const auth = await actor(tx, claimed, true), command = await tx.videoCommand.findUnique({ where: { id: commandId } });
    if (command && (command.actorId !== auth.person.id || command.actorEpoch !== auth.person.epoch)) denied();
    await auth.finish();
    return { confirmed: Boolean(command), videoId: command?.videoId ?? null };
  });
}
export async function readVideoSetup(db: PrismaClient, claimed: AuthSession, id: string) {
  return transaction(db, async tx => {
    const auth = await actor(tx, claimed, true), row = await entry(tx, id), file = await readyFile(tx, row.fileId);
    const people = (await directory(tx)).filter(p => p.active && !p.deleted && p.canRead).map(({ id, name, role }) => ({ id, name, role }));
    await auth.finish();
    return { id: row.id, version: row.version, state: row.state as VideoPublication['state'], details: details(row), fileName: file.fileName, people };
  });
}
async function admission(tx: Tx, row: VideoEntry, file: VideoAsset, recipient: VideoPerson, now: Date, download = false) {
  const authorRow = row.publishedById ? await tx.user.findUnique({ where: { id: row.publishedById }, select: userSelection }) : null;
  const author = authorRow ? person(authorRow) : null, value = publication(row, file);
  return download ? canDownloadPublishedVideo(value, recipient, author, now) : canReadPublishedVideo(value, recipient, author, now);
}
export async function listVideos(db: PrismaClient, claimed: AuthSession, query = '', manage = false) {
  const search = z.string().max(160).parse(query).trim().toLocaleLowerCase('it-IT');
  return transaction(db, async tx => {
    const auth = await actor(tx, claimed, manage), rows = await tx.videoEntry.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }] });
    const results: (ReturnType<typeof item> & { state: string })[] = [];
    for (const candidate of rows) {
      const row = await entry(tx, candidate.id), file = await readyFile(tx, row.fileId), now = await auth.finish();
      if (!manage && !await admission(tx, row, file, auth.person, now)) continue;
      if (search && ![row.title, row.description, row.category].some(value => value.toLocaleLowerCase('it-IT').includes(search))) continue;
      results.push({ ...item(row, file), state: row.state });
    }
    const now = await auth.finish();
    return results.filter(row => manage || !row.expiresAt || new Date(row.expiresAt) > now);
  });
}
export async function readVideo(db: PrismaClient, claimed: AuthSession, id: string) {
  return transaction(db, async tx => {
    const auth = await actor(tx, claimed), row = await entry(tx, id), file = await readyFile(tx, row.fileId);
    if (!await admission(tx, row, file, auth.person, await auth.finish())) denied();
    const result = item(row, file), now = await auth.finish();
    if (row.expiresAt && row.expiresAt <= now) denied();
    return result;
  });
}
/** Normal playback never uses an Admin override. Management/recipient preview
 * requires the current Admin proof and cannot grant access or change the viewer. */
export async function readVideoBytes(db: PrismaClient, claimed: AuthSession, id: string, options: {
  download?: boolean; preview?: boolean; asRecipient?: string; proof?: Proof;
} = {}) {
  return transaction(db, async tx => {
    if ((options.preview || options.asRecipient) && (!options.proof || options.download)) denied();
    const auth = await actor(tx, claimed, Boolean(options.preview || options.asRecipient), options.proof);
    const row = await entry(tx, id), file = await readyFile(tx, row.fileId);
    let recipient = auth.person;
    if (options.asRecipient) {
      const target = await tx.user.findUnique({ where: { id: z.string().min(1).max(128).parse(options.asRecipient) }, select: userSelection });
      if (!target) denied(); recipient = person(target);
    }
    if (!options.preview || options.asRecipient) {
      if (!await admission(tx, row, file, recipient, await auth.finish(), options.download)) denied();
    }
    const bytes = await readPrivateVideoFile(file.id, file), now = await auth.finish();
    if ((!options.preview || options.asRecipient) && row.expiresAt && row.expiresAt <= now) denied();
    return { bytes, mimeType: file.mimeType as 'video/mp4' | 'video/webm', fileName: file.fileName };
  });
}
export async function readVideoPreview(db: PrismaClient, claimed: AuthSession, id: string, proof: Proof, asRecipient?: string) {
  return transaction(db, async tx => {
    const auth = await actor(tx, claimed, true, proof), row = await entry(tx, id), file = await readyFile(tx, row.fileId);
    let allowed = true, recipientName: string | null = null;
    if (asRecipient) {
      const target = await tx.user.findUnique({ where: { id: z.string().min(1).max(128).parse(asRecipient) }, select: userSelection });
      if (!target) denied();
      recipientName = target.name;
      allowed = await admission(tx, row, file, person(target), await auth.finish());
    }
    const now = await auth.finish();
    if (asRecipient && row.expiresAt && row.expiresAt <= now) allowed = false;
    return { video: { ...item(row, file), downloadAllowed: false }, allowed, recipientName };
  });
}
