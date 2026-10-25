import { z } from 'zod';
import { selectedDocumentMimeTypes } from './selected-document-formats';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const clientDocumentChoiceSchema = z.object({ versionId: identifier, download: z.boolean() }).strict();
export const clientDocumentSnapshotSchema = z.object({
  documentId: identifier, versionId: identifier, version: z.number().int().positive(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/), stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().max(500), fileName: z.string().max(500),
  mimeType: z.enum(selectedDocumentMimeTypes),
  download: z.boolean(),
}).strict();
export type ClientDocumentChoice = z.infer<typeof clientDocumentChoiceSchema>;
export type ClientDocumentSnapshot = z.infer<typeof clientDocumentSnapshotSchema>;
export const maxClientDocuments = 20;
export const maxClientDocumentBytes = 25 * 1024 * 1024;

/** Exact version selection, never a wildcard, current-file alias or automatic
 * approval for a future upload. No storage path leaves this boundary. */
export function clientDocumentChoicesMatch(choices: readonly ClientDocumentChoice[], snapshots: readonly ClientDocumentSnapshot[]) {
  return choices.length === snapshots.length && choices.length <= maxClientDocuments
    && new Set(choices.map(row => row.versionId)).size === choices.length
    && new Set(snapshots.map(row => row.versionId)).size === snapshots.length
    && choices.every(chosen => snapshots.some(row => row.versionId === chosen.versionId && row.download === chosen.download));
}
