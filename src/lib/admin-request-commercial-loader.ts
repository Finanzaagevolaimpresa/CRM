import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewLead } from './access-control';
import { isSelectiveClient } from './selective-client-policy';
import { commercialAdminRequestContext } from './admin-request-commercial-context';
import type { CurrentCommercialRequestAdmission } from './admin-request-contract';
import { currentRecordUpdateUser, recordUpdatePermission } from './record-update-context';
import { updateActor } from './record-updates';
import { withSerializableTransaction } from './serializable';

const subjectSchema = z.object({ kind: z.enum(['Lead', 'Client']),
  targetId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict();
const clientSelection = { id: true, recordUpdateEpoch: true, deletedAt: true, status: true, salesOwnerId: true } as const;
const leadSelection = { id: true, recordUpdateEpoch: true, deletedAt: true, status: true, assignedToId: true, clientId: true } as const;
type Tx = Prisma.TransactionClient;
type Actor = NonNullable<Awaited<ReturnType<typeof currentRecordUpdateUser>>>;
export class AdminRequestContextUnavailable extends Error {
  constructor() { super('Richiesta interna non disponibile nel perimetro corrente.'); }
}
function deny(): never { throw new AdminRequestContextUnavailable(); }

/** Shared admission for the atomic queue writer. The caller must have acquired the
 * directory/user/session locks; actor is a current DB principal, not a cookie.
 * Parent linkage is read again after locking. No text or financial data is read.
 */
export async function lockCommercialAdminRequestContext(tx: Tx, actor: Actor, rawSubject: unknown) {
  const subject = subjectSchema.parse(rawSubject);
  if (actor.role !== 'commerciale' || !actor.active || actor.deletedAt) deny();
  let l: Prisma.LeadGetPayload<{ select: typeof leadSelection }> | null = null;
  if (subject.kind === 'Lead') {
    if (!recordUpdatePermission(actor, 'lead.read')) deny();
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${subject.targetId} FOR SHARE`;
    l = await tx.lead.findUnique({ where: { id: subject.targetId }, select: leadSelection });
    if (!l || !canViewLead(actor, l) || l.assignedToId !== actor.id) deny();
  } else if (!recordUpdatePermission(actor, 'client.read')) deny();
  const clientId = subject.kind === 'Client' ? subject.targetId : l!.clientId;
  let c: Prisma.ClientGetPayload<{ select: typeof clientSelection }> | null = null;
  if (clientId) {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${clientId} FOR SHARE`;
    c = await tx.client.findUnique({ where: { id: clientId }, select: clientSelection });
    if (!c || !recordUpdatePermission(actor, 'client.read') || c.salesOwnerId !== actor.id
      || isSelectiveClient(actor, c.id)) deny();
  }
  const context = commercialAdminRequestContext({ ...subject, lead: l, client: c });
  if (!context || context.commercialOwnerId !== actor.id) deny();
  return context;
}

/** Session-bound helper for commercial-only callers, not a
 * way for an Admin to impersonate a requester. A command must persist
 * its event/receipt/audit inside work(), before the final DB clock check.
 * GET loaders must provide a read-only callback; this helper writes nothing.
 */
export function withCommercialAdminRequestContext<T>(db: PrismaClient, claimed: AuthSession, rawSubject: unknown,
  work: (tx: Tx, state: { admission: CurrentCommercialRequestAdmission;
    actor: Actor; sessionId: string; context: NonNullable<ReturnType<typeof commercialAdminRequestContext>> }) => Promise<T>) {
  const subject = subjectSchema.parse(rawSubject);
  return withSerializableTransaction(db, async tx => {
    const auth = await updateActor(tx, claimed);
    if (!auth.registry.live || auth.actor.role !== 'commerciale') deny();
    const context = await lockCommercialAdminRequestContext(tx, auth.actor, subject);
    const admission: CurrentCommercialRequestAdmission = {
      role: auth.actor.role, userId: auth.actor.id, active: auth.actor.active,
      sessionLive: true, registryCurrent: true, recordWorkable: true, selectiveCeilingAllows: true,
      subject, commercialOwnerId: context.commercialOwnerId, contextSha256: context.contextSha256,
      recipientEpoch: auth.actor.recordUpdateEpoch, accessRevision: context.accessRevision,
    };
    const result = await work(tx, { admission, actor: auth.actor, sessionId: auth.registry.id, context });
    await auth.finish();
    return result;
  });
}
