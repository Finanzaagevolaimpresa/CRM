import { Prisma } from '@prisma/client';
import type { AuthSession } from './auth';
import { updateActor, type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { currentTechnicalRestriction } from './technical-account-membership';
import { DriveFolderError } from './drive-folder-contract';
import type { FolderPerson } from './drive-folder-policy';

type Tx = Prisma.TransactionClient;
const selection = { id: true, name: true, email: true, role: true, active: true, deletedAt: true, recordUpdateEpoch: true,
  permissionOverrides: { select: { permission: true, allowed: true } } } as const;
function person(row: Prisma.UserGetPayload<{ select: typeof selection }> & { technicalRestricted?: boolean }): FolderPerson {
  return { id: row.id, name: row.name, email: row.email, role: row.role, active: row.active, deleted: Boolean(row.deletedAt),
    epoch: row.recordUpdateEpoch, technicalRestricted: row.technicalRestricted,
    canRead: recordUpdatePermission(row, 'drive_folders.read'),
    canManage: row.role === 'admin' && recordUpdatePermission(row, 'drive_folders.manage') };
}
export async function currentFolderDirectory(tx: Tx) {
  const rows = await tx.user.findMany({ select: selection, orderBy: { id: 'asc' } });
  return Promise.all(rows.map(async row => person({ ...row, technicalRestricted: await currentTechnicalRestriction(tx, row.id, row) })));
}
export async function currentFolderActor(tx: Tx, claimed: AuthSession, manage = false, proof?: UpdateCredentials) {
  const auth = await updateActor(tx, claimed, proof), current = person(auth.actor);
  if (!current.canRead || manage && !current.canManage) throw new DriveFolderError('DENIED');
  return { ...auth, person: current };
}
