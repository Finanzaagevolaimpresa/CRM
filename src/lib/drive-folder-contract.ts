import { z } from 'zod';

export const driveFolderModel = 'DriveFolderReference';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const opaqueId = /^[A-Za-z0-9_-]{10,200}$/;
/** A folder reference only. Never fetch a URL, follow redirects or read files. */
export function parseDriveFolderLink(raw: string) {
  const invalid = (): never => { throw new Error('DRIVE_FOLDER_LINK_INVALID'); };
  if (raw.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(raw.trim())) invalid();
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.host !== 'drive.google.com' || url.username || url.password || url.hash) invalid();
  const match = /^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  const folderId = match?.[1], resourceKey = url.searchParams.get('resourcekey');
  if (!folderId || !opaqueId.test(folderId) || resourceKey !== null && !opaqueId.test(resourceKey)
    || [...url.searchParams.keys()].some(key => !['usp', 'resourcekey'].includes(key))
    || ['usp', 'resourcekey'].some(key => url.searchParams.getAll(key).length > 1)) return invalid();
  return { folderId, url: 'https://drive.google.com/drive/folders/' + folderId
    + (resourceKey ? '?resourcekey=' + encodeURIComponent(resourceKey) : '') };
}
const link = z.string().trim().max(2048).transform((value, ctx) => {
  try { return parseDriveFolderLink(value).url; }
  catch { ctx.addIssue({ code: 'custom', message: 'Inserisci un link https://drive.google.com/drive/folders/… alla cartella, non a un file.' }); return z.NEVER; }
});
export const driveFolderDetails = z.object({
  clientId: id, title: z.string().trim().min(1).max(160), url: link,
  people: z.array(id).max(100).refine(ids => new Set(ids).size === ids.length),
  technicalContentReviewed: z.boolean(), expiresAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
const base = z.object({ protocol: z.literal('DRIVE_FOLDER_REFERENCE_V1'), commandId: z.string().uuid(),
  folderId: z.string().uuid(), expectedVersion: z.number().int().min(0).max(2_147_483_646) });
export const driveFolderCommand = z.discriminatedUnion('operation', [
  base.extend({ operation: z.literal('SAVE_DRAFT'), details: driveFolderDetails }).strict(),
  base.extend({ operation: z.literal('ACTIVATE'), details: driveFolderDetails }).strict(),
  base.extend({ operation: z.literal('DISABLE') }).strict(),
]);
export const driveFolderSnapshot = z.object({ id: z.string().uuid(), revision: z.number().int().positive(),
  state: z.enum(['DRAFT', 'ACTIVE', 'DISABLED']), details: driveFolderDetails,
  clientName: z.string().min(1), clientEpoch: z.number().int().positive(),
  audience: z.array(z.object({ id, epoch: z.number().int().positive(), role: z.string() }).strict()).max(100),
  publisherId: id.nullable(), publisherEpoch: z.number().int().positive().nullable(), updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type DriveFolderCommand = z.infer<typeof driveFolderCommand>;
export type DriveFolderDetails = z.infer<typeof driveFolderDetails>;
export type DriveFolderSnapshot = z.infer<typeof driveFolderSnapshot>;
export class DriveFolderError extends Error {
  constructor(public readonly code: 'DENIED' | 'STALE' | 'CLOSED' | 'DUPLICATE' | 'CONTENT_REVIEW_REQUIRED' | 'RECIPIENT_UNAVAILABLE' | 'CLIENT_UNAVAILABLE') { super('DRIVE_FOLDER_' + code); }
}
