import { canReadPublishedVideo, resolveVideoAudience, type VideoPerson } from './video-access-policy';
import { DriveFolderError, type DriveFolderSnapshot, type DriveFolderDetails } from './drive-folder-contract';
import { isTechnicalAccount } from './technical-confidentiality';

// Reuse only the pure named-audience controls. This directory is evaluated with
// drive_folders permissions; no Video record, permission, grant or file is used.
export type FolderPerson = VideoPerson;
export function resolveFolderAudience(details: DriveFolderDetails, directory: FolderPerson[], activating: boolean) {
  if (!details.people.length) {
    if (activating) throw new DriveFolderError('RECIPIENT_UNAVAILABLE');
    return null;
  }
  let selected;
  try { selected = resolveVideoAudience({ people: details.people, areas: [], technicalContentReviewed: details.technicalContentReviewed }, directory); }
  catch { throw new DriveFolderError('RECIPIENT_UNAVAILABLE'); }
  if (activating && details.technicalContentReviewed !== true
    && selected.audience.some(member => isTechnicalAccount(directory.find(person => person.id === member.id)!))) {
    throw new DriveFolderError('CONTENT_REVIEW_REQUIRED');
  }
  return selected;
}
export type FolderClient = { id: string; displayName: string; status: string; deletedAt: Date | null; recordUpdateEpoch: number };
export function folderClientAvailable(client: FolderClient | null) {
  return !!client && !client.deletedAt && client.status === 'attivo';
}
export function folderClientMatches(row: DriveFolderSnapshot, client: FolderClient | null) {
  return folderClientAvailable(client) && client!.id === row.details.clientId && client!.recordUpdateEpoch === row.clientEpoch;
}
export function canReadFolder(row: DriveFolderSnapshot, client: FolderClient | null, person: FolderPerson, author: FolderPerson | null, now: Date) {
  return folderClientMatches(row, client) && canReadPublishedVideo({ state: row.state === 'ACTIVE' ? 'PUBLISHED' : 'DRAFT',
    fileReady: true, expiresAt: row.details.expiresAt ? new Date(row.details.expiresAt) : null,
    authorId: row.publisherId, authorEpoch: row.publisherEpoch, audience: row.audience, downloadAllowed: false,
    technicalContentReviewed: row.details.technicalContentReviewed }, person, author, now);
}
