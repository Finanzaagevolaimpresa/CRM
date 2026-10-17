import { hasPermission, type PermissionSession } from './permission-evaluator';
export const communicationFileMaxBytes = 20 * 1024 * 1024;
export const communicationFileContextMaxBytes = 200 * 1024 * 1024;
export const communicationFileContextMaxCount = 100;
export function canReadCommunicationFile(actor: PermissionSession, classification: string) {
  return classification === 'ORDINARY' || (classification === 'SENSITIVE' && hasPermission(actor, 'document.sensitive.read'))
    || (classification === 'COMPLAINT' && actor.role === 'admin');
}
export function communicationFileFitsClassification(file: string, message: string) {
  return file === 'ORDINARY' || file === message || (file === 'SENSITIVE' && message === 'COMPLAINT');
}
