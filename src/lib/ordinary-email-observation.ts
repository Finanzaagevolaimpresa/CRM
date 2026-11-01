import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { localPathFromStoragePath } from './storage';
import type { OrdinaryAttemptLease, OrdinaryAttemptRequest, OrdinarySmtpResult } from './ordinary-email-smtp-candidate';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ordinaryObservationSchema = z.object({
  protocol: z.literal('FAI_ORDINARY_TRANSPORT_OBSERVATION_V1'), attemptId: z.string().uuid(),
  claimExpiresAt: z.string().datetime(), intentHash: hash, mimeHash: hash, envelopeHash: hash,
  outcome: z.enum(['ACCEPTED', 'NOT_SENT']),
  phase: z.enum(['CLAIM','CONNECT','GREETING','EHLO','AUTH','MAIL','RCPT','DATA','CONTENT']),
  replyCode: z.number().int().min(200).max(599).nullable(), observedAt: z.string().datetime(),
}).strict().refine(value => value.outcome === 'ACCEPTED'
  ? value.phase === 'CONTENT' && value.replyCode === 250
  : value.phase !== 'CONTENT' || (value.replyCode !== null && value.replyCode >= 400));
const sealedSchema = z.object({ observation: ordinaryObservationSchema, mac: hash }).strict();
export type OrdinaryTransportObservation = z.infer<typeof ordinaryObservationSchema>;
export type SealedOrdinaryObservation = z.infer<typeof sealedSchema>;
export type OrdinaryObservationSink = (lease: OrdinaryAttemptLease, request: OrdinaryAttemptRequest,
  result: OrdinarySmtpResult, observedAt: Date) => Promise<void>;
function mac(lease: OrdinaryAttemptLease, observation: OrdinaryTransportObservation) {
  z.string().uuid().parse(lease.leaseId);
  if (!lease.committed || lease.attemptId !== observation.attemptId || lease.expiresAt !== observation.claimExpiresAt)
    throw new Error('ORDINARY_OBSERVATION_BINDING');
  // The one-use private claim capability never enters this file or the browser.
  // Its binding survives rotation of the current interactive confirmation key.
  return createHmac('sha256', lease.leaseId).update('fai.ordinary-observation.v1\n' + canonicalJson(observation)).digest('hex');
}
export function sealOrdinaryObservation(lease: OrdinaryAttemptLease, request: OrdinaryAttemptRequest,
  result: OrdinarySmtpResult, observedAt: Date): SealedOrdinaryObservation {
  if (request.attemptId !== lease.attemptId) throw new Error('ORDINARY_OBSERVATION_BINDING');
  const observation = ordinaryObservationSchema.parse({ protocol: 'FAI_ORDINARY_TRANSPORT_OBSERVATION_V1',
    attemptId: request.attemptId, claimExpiresAt: lease.expiresAt, intentHash: request.intentHash,
    mimeHash: request.mimeHash, envelopeHash: request.envelopeHash, outcome: result.outcome,
    phase: result.phase, replyCode: result.replyCode ?? null, observedAt: observedAt.toISOString() });
  return { observation, mac: mac(lease, observation) };
}
export function verifyOrdinaryObservation(raw: unknown, lease: OrdinaryAttemptLease,
  expected: Pick<OrdinaryAttemptRequest, 'intentHash' | 'mimeHash' | 'envelopeHash'>) {
  const sealed = sealedSchema.parse(raw), o = sealed.observation;
  if (o.intentHash !== expected.intentHash || o.mimeHash !== expected.mimeHash || o.envelopeHash !== expected.envelopeHash
    || !timingSafeEqual(Buffer.from(sealed.mac, 'hex'), Buffer.from(mac(lease, o), 'hex')))
    throw new Error('ORDINARY_OBSERVATION_INVALID');
  return { observation: o, sourceHash: canonicalSha256(sealed) };
}

/** Independent private journal. No address, content, transport configuration or
 * interactive key is stored. No arbitrary path or evidence supplied by a form. */
async function location(attemptId: string, create: boolean) {
  z.string().uuid().parse(attemptId);
  const configured = localPathFromStoragePath('ordinary-email-observations');
  const root = await realpath(path.dirname(configured));
  const directory = path.join(root, 'ordinary-email-observations');
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory)
    throw new Error('ORDINARY_OBSERVATION_STORAGE');
  return { directory, file: path.join(directory, attemptId.toLowerCase() + '.json') };
}
async function readAt(file: string) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 4096)
    throw new Error('ORDINARY_OBSERVATION_STORAGE');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size)
      throw new Error('ORDINARY_OBSERVATION_CHANGED');
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) { const r = await handle.read(buffer, used, buffer.length - used, null); if (!r.bytesRead) break; used += r.bytesRead; }
    const after = await handle.stat();
    if (used !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error('ORDINARY_OBSERVATION_CHANGED');
    const raw = buffer.subarray(0, used).toString('utf8'), parsed = sealedSchema.parse(JSON.parse(raw));
    if (raw !== canonicalJson(parsed)) throw new Error('ORDINARY_OBSERVATION_INVALID');
    return parsed;
  } finally { await handle.close(); }
}
export const writeOrdinaryObservation: OrdinaryObservationSink = async (lease, request, result, observedAt) => {
  const sealed = sealOrdinaryObservation(lease, request, result, observedAt);
  const { directory, file } = await location(lease.attemptId, true), bytes = Buffer.from(canonicalJson(sealed));
  let handle;
  try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || canonicalJson(await readAt(file)) !== bytes.toString('utf8')) throw error;
    return;
  }
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  // POSIX directory fsync persists the new name. Windows does not expose it;
  // the file itself is flushed and existing data is never overwritten.
  if (process.platform !== 'win32') { const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
};
export async function readOrdinaryObservation(attemptId: string) {
  const { file } = await location(attemptId, false);
  return readAt(file);
}
