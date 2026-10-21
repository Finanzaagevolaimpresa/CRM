import { z } from 'zod';
import { clientDocumentChoiceSchema, clientDocumentSnapshotSchema, clientDocumentChoicesMatch,
  maxClientDocumentBytes, maxClientDocuments } from './selective-client-document-policy';

export const practiceDocumentChoiceSchema = clientDocumentChoiceSchema;
export type PracticeDocumentChoice = z.infer<typeof practiceDocumentChoiceSchema>;
export const maxPracticeDocuments = maxClientDocuments;
export const maxPracticeDocumentBytes = maxClientDocumentBytes;
export const practiceDocumentSnapshotSchema = clientDocumentSnapshotSchema.extend({
  practiceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export type PracticeDocumentSnapshot = z.infer<typeof practiceDocumentSnapshotSchema>;

/** The retained signed selection is the explicit practice/version association.
 * A client or service relationship alone never establishes this association. */
export function practiceDocumentChoicesMatch(practiceId: string,
  choices: readonly PracticeDocumentChoice[], snapshots: readonly PracticeDocumentSnapshot[]) {
  return clientDocumentChoicesMatch(choices, snapshots)
    && snapshots.every(row => row.practiceId === practiceId);
}

export type PracticeDocumentContext = {
  id: string; clientId: string; projectId: string | null; clientServiceId: string | null;
  serviceProjectId: string | null;
};
export function documentEligibleForPractice(context: PracticeDocumentContext,
  document: { clientId: string | null; projectId: string | null; clientServiceId: string | null }) {
  return document.clientId === context.clientId
    && (!document.projectId || document.projectId === context.projectId || document.projectId === context.serviceProjectId)
    && (!document.clientServiceId || document.clientServiceId === context.clientServiceId);
}
