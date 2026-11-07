import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import type { UpdateCredentials } from './record-updates';
import { canonicalSha256 as hash } from './canonical-json';
import { mapSerializableConflict } from './serializable';
import { currentFolderActor, currentFolderDirectory } from './drive-folder-authority';
import { canReadFolder, folderClientAvailable, folderClientMatches, resolveFolderAudience, type FolderClient, type FolderPerson } from './drive-folder-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { createFolderDecision, verifyFolderDecision } from './drive-folder-decision';
import { DriveFolderError, driveFolderCommand, driveFolderModel, driveFolderSnapshot, parseDriveFolderLink,
  type DriveFolderCommand, type DriveFolderSnapshot } from './drive-folder-contract';

type Tx = Prisma.TransactionClient;
type Authority = Awaited<ReturnType<typeof currentFolderActor>>;
function deny(): never { throw new DriveFolderError('DENIED'); }
function stale(): never { throw new DriveFolderError('STALE'); }
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
async function clientRow(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${id} FOR SHARE`;
  return tx.client.findUnique({ where: { id }, select: { id: true, displayName: true, status: true, deletedAt: true, recordUpdateEpoch: true } });
}
/** Typed references are journalled, never stored as documents or video entries.
 * Call under drive-folder-directory lock, after the native authority lock. */
async function load(tx: Tx, id: string) {
  z.string().uuid().parse(id);
  const rows = await tx.adminRecordRevision.findMany({ where: { model: driveFolderModel, recordId: id, operation: { not: 'CLOSE' } } });
  const history = rows.map(row => {
    const before = row.before === null ? null : driveFolderSnapshot.parse(row.before), after = driveFolderSnapshot.parse(row.after);
    if (after.id !== id || before && before.id !== id || hash(before) !== row.beforeHash || hash(after) !== row.afterHash
      || row.operation !== (before ? 'UPDATE' : 'CREATE') || after.revision !== (before?.revision ?? 0) + 1
      || new Set(after.audience.map(person => person.id)).size !== after.audience.length
      || after.state === 'ACTIVE' && (after.publisherId !== row.actorId || !after.publisherEpoch || !after.audience.length)
      || after.state !== 'ACTIVE' && (after.publisherId !== null || after.publisherEpoch !== null || after.audience.length)) deny();
    return { commandId: row.commandId, actorId: row.actorId, createdAt: row.createdAt.toISOString(), before, after };
  }).sort((a, b) => a.after.revision - b.after.revision);
  let current: DriveFolderSnapshot | null = null;
  for (const row of history) {
    if (hash(current) !== hash(row.before)) deny();
    current = row.after;
  }
  return { current, history };
}
async function all(tx: Tx) {
  const ids = await tx.adminRecordRevision.findMany({ where: { model: driveFolderModel, operation: 'CREATE' }, select: { recordId: true }, orderBy: { recordId: 'asc' } });
  const rows: DriveFolderSnapshot[] = [];
  for (const { recordId } of ids) { const row = (await load(tx, recordId)).current; if (row) rows.push(row); }
  return rows;
}
async function journal(tx: Tx, auth: Authority, input: DriveFolderCommand, before: DriveFolderSnapshot | null, after: DriveFolderSnapshot | null, closing = false) {
  const operation = closing ? 'CLOSE' : before ? 'UPDATE' : 'CREATE', beforeHash = hash(before), afterHash = hash(after);
  const plain = (value: DriveFolderSnapshot | null) => value === null ? Prisma.JsonNull : JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  await tx.adminRecordRevision.create({ data: { commandId: input.commandId, model: driveFolderModel, recordId: input.folderId,
    actorId: auth.person.id, sessionId: auth.registry.id, requestHash: hash(input), operation, beforeHash, afterHash,
    before: plain(before), after: plain(after), reason: 'Fascicoli Drive · ' + input.operation } });
  await tx.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: auth.person.id,
    entityType: driveFolderModel, entityId: input.folderId, event: closing ? 'admin_record_attempt_closed' : 'admin_record_changed',
    after: closing ? { commandId: input.commandId } : { commandId: input.commandId, action: operation, beforeHash, afterHash,
      source: 'GOOGLE_DRIVE_FOLDER_REFERENCE', transition: input.operation, revision: after!.revision, recipients: after!.audience.length } } });
}
async function proposal(tx: Tx, claimed: AuthSession, input: DriveFolderCommand, proof?: UpdateCredentials) {
  const auth = await currentFolderActor(tx, claimed, true, proof);
  await lock(tx, 'drive-folder-directory', Boolean(proof));
  const { current } = await load(tx, input.folderId);
  if ((current?.revision ?? 0) !== input.expectedVersion || !current && input.operation !== 'SAVE_DRAFT') stale();
  const details = 'details' in input ? input.details : current!.details;
  // Moving a folder to another client, or replacing its URL, first withdraws it.
  if (input.operation === 'ACTIVATE' && (current?.details.url !== details.url || current.details.clientId !== details.clientId)) stale();
  const client = await clientRow(tx, details.clientId);
  if (input.operation !== 'DISABLE') {
    if (!folderClientAvailable(client)) throw new DriveFolderError('CLIENT_UNAVAILABLE');
    const folderId = parseDriveFolderLink(details.url).folderId;
    if ((await all(tx)).some(row => row.id !== input.folderId && parseDriveFolderLink(row.details.url).folderId === folderId)) {
      throw new DriveFolderError('DUPLICATE');
    }
  }
  const directory = await currentFolderDirectory(tx);
  // Disable must remain possible even when recipients or the client no longer exist.
  const selected = input.operation === 'DISABLE' ? null : resolveFolderAudience(details, directory, input.operation === 'ACTIVATE');
  const now = await auth.finish(), expiry = details.expiresAt ? new Date(details.expiresAt) : null;
  if (input.operation === 'ACTIVATE' && expiry && expiry <= now) deny();
  const digest = hash({ input, before: current, actor: auth.person.id, epoch: auth.person.epoch,
    session: auth.registry.id, directory: selected?.binding ?? null,
    client: client ? { ...client, deletedAt: client.deletedAt?.toISOString() ?? null } : null });
  return { auth, current, client, details, selected, digest, expiry };
}
export async function previewDriveFolder(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = driveFolderCommand.parse(raw), key = await loadActivePrivilegedStepUpKey(db);
  if (!key) deny();
  return transaction(db, async tx => {
    const p = await proposal(tx, claimed, input), now = await p.auth.finish();
    return { digest: createFolderDecision(key, { actorId: p.auth.person.id, actorEpoch: p.auth.person.epoch, sessionId: p.auth.registry.id }, input, p.digest, now),
      clientName: p.client?.displayName ?? p.current!.clientName, title: p.details.title, url: p.details.url,
      people: p.selected?.people ?? [], expiresAt: p.details.expiresAt };
  });
}
export async function confirmDriveFolder(db: PrismaClient, claimed: AuthSession, raw: unknown, token: string, proof: UpdateCredentials) {
  const input = driveFolderCommand.parse(raw);
  return transaction(db, async tx => {
    const auth = await currentFolderActor(tx, claimed, true, proof);
    await lock(tx, 'admin-record:' + input.commandId);
    const receipt = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (receipt) {
      if (receipt.actorId !== auth.person.id || receipt.sessionId !== auth.registry.id || receipt.model !== driveFolderModel
        || receipt.recordId !== input.folderId || receipt.requestHash !== hash(input)) deny();
      if (receipt.operation === 'CLOSE') throw new DriveFolderError('CLOSED');
      await lock(tx, 'drive-folder-directory', false); await load(tx, input.folderId); await auth.finish();
      return { confirmed: true, closed: false };
    }
    const p = await proposal(tx, claimed, input, proof);
    const identity = { actorId: auth.person.id, actorEpoch: auth.person.epoch, sessionId: auth.registry.id };
    const now = await auth.finish(), claims = verifyFolderDecision(proof.key, identity, input, token, now);
    if (claims.decisionHash !== p.digest) stale();
    const active = input.operation === 'ACTIVATE';
    const after = driveFolderSnapshot.parse({ id: input.folderId, revision: (p.current?.revision ?? 0) + 1,
      state: active ? 'ACTIVE' : input.operation === 'DISABLE' ? 'DISABLED' : 'DRAFT', details: p.details,
      clientName: p.client?.displayName ?? p.current!.clientName, clientEpoch: p.client?.recordUpdateEpoch ?? p.current!.clientEpoch,
      audience: active ? p.selected!.audience : [], publisherId: active ? auth.person.id : null,
      publisherEpoch: active ? auth.person.epoch : null, updatedAt: now.toISOString() });
    await journal(tx, auth, input, p.current, after);
    const end = await auth.finish(); verifyFolderDecision(proof.key, identity, input, token, end);
    if (active && p.expiry && p.expiry <= end) deny();
    return { confirmed: true, closed: false };
  });
}
/** Same command ID serializes lost-response reconciliation with the mutation.
 * Absence becomes terminal CLOSE; it never authorizes a blind resend. */
export async function settleDriveFolder(db: PrismaClient, claimed: AuthSession, raw: unknown, token: string) {
  const input = driveFolderCommand.parse(raw), key = await loadActivePrivilegedStepUpKey(db);
  if (!key) deny();
  return transaction(db, async tx => {
    const auth = await currentFolderActor(tx, claimed, true);
    verifyFolderDecision(key, { actorId: auth.person.id, actorEpoch: auth.person.epoch, sessionId: auth.registry.id }, input, token, await auth.finish(), { closing: true });
    await lock(tx, 'admin-record:' + input.commandId);
    const row = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (row && (row.actorId !== auth.person.id || row.sessionId !== auth.registry.id || row.model !== driveFolderModel
      || row.recordId !== input.folderId || row.requestHash !== hash(input))) deny();
    if (!row) await journal(tx, auth, input, null, null, true);
    else if (row.operation !== 'CLOSE') { await lock(tx, 'drive-folder-directory', false); await load(tx, input.folderId); }
    await auth.finish(); return { confirmed: Boolean(row && row.operation !== 'CLOSE'), closed: !row || row.operation === 'CLOSE' };
  });
}
function allowed(row: DriveFolderSnapshot, client: FolderClient | null, person: FolderPerson, directory: FolderPerson[], now: Date) {
  return canReadFolder(row, client, person, directory.find(p => p.id === row.publisherId) ?? null, now);
}
const view = (row: DriveFolderSnapshot) => ({ id: row.id, version: row.revision, state: row.state, title: row.details.title,
  clientId: row.details.clientId, clientName: row.clientName, url: row.details.url, expiresAt: row.details.expiresAt });
export async function readDriveFolder(db: PrismaClient, claimed: AuthSession, id: string, manage = false) {
  return transaction(db, async tx => {
    const auth = await currentFolderActor(tx, claimed, manage); await lock(tx, 'drive-folder-directory', false);
    const row = (await load(tx, id)).current; if (!row) deny();
    const client = await clientRow(tx, row.details.clientId), directory = await currentFolderDirectory(tx);
    if (!manage && !allowed(row, client, auth.person, directory, await auth.finish())) deny();
    const end = await auth.finish(); if (!manage && !allowed(row, client, auth.person, directory, end)) deny();
    return view(row);
  });
}
export async function driveFolderSetup(db: PrismaClient, claimed: AuthSession, id: string) {
  return transaction(db, async tx => {
    const auth = await currentFolderActor(tx, claimed, true); await lock(tx, 'drive-folder-directory', false);
    const loaded = await load(tx, id), directory = await currentFolderDirectory(tx);
    const clients = await tx.client.findMany({ select: { id: true, displayName: true, status: true, deletedAt: true, recordUpdateEpoch: true }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }] });
    await auth.finish();
    return { id, current: loaded.current, history: loaded.history.map(r => ({ commandId: r.commandId, actorId: r.actorId,
      createdAt: r.createdAt, revision: r.after.revision, state: r.after.state })),
      clients: clients.filter(folderClientAvailable).map(({ id, displayName }) => ({ id, name: displayName })),
      people: directory.filter(p => p.active && !p.deleted).map(({ id, name, email, role, canRead }) => ({ id, name, email, role, canRead })) };
  });
}
export async function listDriveFolders(db: PrismaClient, claimed: AuthSession, options: { query?: string; manage?: boolean; clientId?: string } = {}) {
  const search = z.string().max(160).parse(options.query ?? '').trim().toLocaleLowerCase('it-IT');
  if (options.clientId !== undefined) z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).parse(options.clientId);
  return transaction(db, async tx => {
    const auth = await currentFolderActor(tx, claimed, options.manage); await lock(tx, 'drive-folder-directory', false);
    const directory = await currentFolderDirectory(tx), candidates: { row: DriveFolderSnapshot; client: FolderClient | null }[] = [];
    for (const row of await all(tx)) {
      if (options.clientId !== undefined && row.details.clientId !== options.clientId) continue;
      const client = await clientRow(tx, row.details.clientId);
      // Filter authorization before search and before exposing any reference metadata.
      if (!options.manage && !allowed(row, client, auth.person, directory, await auth.finish())) continue;
      if (!search || [row.details.title, row.clientName].some(v => v.toLocaleLowerCase('it-IT').includes(search))) candidates.push({ row, client });
    }
    const end = await auth.finish();
    return candidates.filter(({ row, client }) => options.manage || allowed(row, client, auth.person, directory, end))
      .map(({ row, client }) => ({ ...view(row), clientCurrent: folderClientMatches(row, client),
        expired: !!row.details.expiresAt && new Date(row.details.expiresAt) <= end }))
      .sort((a, b) => a.clientName.localeCompare(b.clientName, 'it') || a.title.localeCompare(b.title, 'it') || a.id.localeCompare(b.id));
  });
}
