import { z } from 'zod';
import { videoDetailsSchema } from './video-input';

export const driveVideoModel = 'DriveVideoReference';
export const driveVideoAccount = 'assistenza@finanzaagevolaimpresa.it' as const;
const opaqueId = /^[A-Za-z0-9_-]{10,200}$/;
/** Parse only a Drive file reference. No network fetch, redirects or credentials. */
export function parseDriveVideoLink(raw: string) {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('DRIVE_VIDEO_LINK_INVALID'); }
  if (raw.length > 2048 || url.protocol !== 'https:' || url.hostname !== 'drive.google.com'
    || url.port || url.username || url.password || url.hash) throw new Error('DRIVE_VIDEO_LINK_INVALID');
  const path = /^\/file\/d\/([A-Za-z0-9_-]+)\/(?:view|preview)\/?$/.exec(url.pathname);
  const open = url.pathname === '/open';
  const id = path?.[1] ?? (open ? url.searchParams.get('id') : null);
  const resourceKey = url.searchParams.get('resourcekey');
  if (!id || !opaqueId.test(id) || resourceKey !== null && !opaqueId.test(resourceKey)
    || [...url.searchParams.keys()].some(key => !['id', 'resourcekey', 'usp'].includes(key))
    || ['id', 'resourcekey', 'usp'].some(key => url.searchParams.getAll(key).length > 1)
    || path && url.searchParams.has('id') || !path && !open) throw new Error('DRIVE_VIDEO_LINK_INVALID');
  const suffix = resourceKey ? '?resourcekey=' + encodeURIComponent(resourceKey) : '';
  return { fileId: id, resourceKey, viewUrl: 'https://drive.google.com/file/d/' + id + '/view' + suffix,
    previewUrl: 'https://drive.google.com/file/d/' + id + '/preview' + suffix };
}
const link = z.string().trim().max(2048).transform((value, ctx) => {
  try { return parseDriveVideoLink(value).viewUrl; }
  catch { ctx.addIssue({ code: 'custom', message: 'Inserisci il link https di un file video Google Drive, non di una cartella.' }); return z.NEVER; }
});
export const driveVideoDetails = videoDetailsSchema.omit({ fileId: true, downloadAllowed: true }).extend({
  url: link, sourceAccount: z.literal(driveVideoAccount), accountConfirmed: z.literal(true),
  // Google controls its own download capability; the CRM exposes no download command.
  downloadAllowed: z.literal(false),
}).strict();
const base = z.object({ protocol: z.literal('DRIVE_VIDEO_REFERENCE_V1'), commandId: z.string().uuid(),
  videoId: z.string().uuid(), expectedVersion: z.number().int().min(0).max(2_147_483_646) });
export const driveVideoCommand = z.discriminatedUnion('operation', [
  base.extend({ operation: z.literal('SAVE_DRAFT'), details: driveVideoDetails }).strict(),
  base.extend({ operation: z.literal('PUBLISH'), details: driveVideoDetails }).strict(),
  base.extend({ operation: z.literal('ARCHIVE') }).strict(),
  base.extend({ operation: z.literal('RESTORE_DRAFT') }).strict(),
]);
export const driveVideoSnapshot = z.object({ id: z.string().uuid(), revision: z.number().int().positive(),
  state: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']), details: driveVideoDetails,
  audience: z.array(z.object({ id: z.string().min(1).max(128), epoch: z.number().int().positive(), role: z.string() }).strict()).max(100),
  publisherId: z.string().min(1).max(128).nullable(), publisherEpoch: z.number().int().positive().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type DriveVideoCommand = z.infer<typeof driveVideoCommand>;
export type DriveVideoDetails = z.infer<typeof driveVideoDetails>;
export type DriveVideoSnapshot = z.infer<typeof driveVideoSnapshot>;
