import type { Prisma } from '@prisma/client';
import type { CommunicationPrincipal } from './communication-principal';
import { recordUpdatePermission } from './record-update-context';

/** Existing personal binding only. This does not qualify a channel or approve mail. */
export async function recordUpdateEmailAuthority(tx: Prisma.TransactionClient, current: CommunicationPrincipal) {
  if (!current.active || current.role !== 'admin'
    || !recordUpdatePermission(current, 'practice_communications.read')
    || !recordUpdatePermission(current, 'practice_communications.write')
    || !recordUpdatePermission(current, 'practice_communications.mark_used')) return null;
  const [row] = await tx.$queryRaw<Array<{ userId: string; mailboxId: string; revision: number; enabled: boolean }>>`
    SELECT "userId","mailboxId","revision","enabled" FROM "OrdinaryEmailAuthority"
    WHERE id='ordinary-email' FOR SHARE`;
  return row?.enabled && row.userId === current.userId ? row : null;
}
