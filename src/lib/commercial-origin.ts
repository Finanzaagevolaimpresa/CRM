import { Prisma, type PrismaClient } from '@prisma/client';
import { UserFacingActionError } from './action-errors';
import { authorizeManualAssignment, type AssignmentActor } from './manual-assignment-guard';
import { commercialOriginEvents, commercialOriginInput, commercialOriginSnapshot, commercialOriginStored, encodeCommercialOrigin, sameCommercialOrigin } from './commercial-origin-contract';

type Db = PrismaClient | Prisma.TransactionClient;
const originWhere = (clientId: string) => ({ entityType: 'Client', entityId: clientId, event: { in: [...commercialOriginEvents] } });
const select = { id: true, actorId: true, createdAt: true, after: true } as const;

function decode(row: { id: string; actorId: string | null; createdAt: Date; after: Prisma.JsonValue }, clientId: string) {
  const parsed = commercialOriginStored.safeParse(row.after);
  if (!parsed.success || parsed.data.clientId !== clientId || !row.actorId) {
    throw new UserFacingActionError('Storico di provenienza non coerente. È necessaria una verifica amministrativa.');
  }
  return { ...row, snapshot: parsed.data };
}

// Callers authorize the client before reading its history. Ordinary ownership is never an origin source.
export async function readCommercialOrigin(db: Db, clientId: string) {
  const row = await db.auditLog.findFirst({ where: originWhere(clientId), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select });
  return row ? decode(row, clientId) : null;
}

export async function readCommercialOriginHistory(db: Db, clientId: string, beforeId?: string) {
  const cursor = beforeId ? await db.auditLog.findFirst({ where: { ...originWhere(clientId), id: beforeId }, select }) : null;
  if (beforeId && !cursor) throw new UserFacingActionError('Pagina dello storico non disponibile.');
  const rows = await db.auditLog.findMany({
    where: { ...originWhere(clientId), ...(cursor ? { OR: [
      { createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ] } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 26, select,
  });
  return { entries: rows.slice(0, 25).map(row => decode(row, clientId)), next: rows.length > 25 ? rows[24].id : null };
}

export async function recordCommercialOrigin(tx: Prisma.TransactionClient, actor: AssignmentActor, raw: unknown, privilegedAdmission: boolean) {
  if (!privilegedAdmission) throw new UserFacingActionError('Conferma amministrativa richiesta.');
  const parsed = commercialOriginInput.safeParse(raw);
  if (!parsed.success) throw new UserFacingActionError('Compila provenienza, riferimento e motivazione.');
  const input = parsed.data;
  await authorizeManualAssignment(tx, actor, []);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Client" WHERE "id"=${input.clientId} AND "deletedAt" IS NULL FOR UPDATE`;
  if (!rows[0]) throw new UserFacingActionError('Cliente non disponibile.');
  const previous = await readCommercialOrigin(tx, input.clientId);
  if ((previous?.id ?? null) !== input.expectedEntryId) throw new UserFacingActionError('La provenienza è stata aggiornata. Riapri la scheda.');
  if (previous && (previous.snapshot.revision === 2_147_483_647 || sameCommercialOrigin(previous.snapshot, input))) {
    throw new UserFacingActionError('Nessuna nuova rettifica da registrare.');
  }
  if (!previous && !input.acquiredById && !input.contractedById) throw new UserFacingActionError('Indica almeno un commerciale documentato.');
  // Historical identities may be suspended, removed, or have changed role. They confer no access.
  for (const id of [...new Set([input.acquiredById, input.contractedById].filter((id): id is string => Boolean(id)))].sort()) {
    const users = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id"=${id} FOR SHARE`;
    if (!users[0]) throw new UserFacingActionError('Una delle identità indicate non è disponibile.');
  }
  const after = commercialOriginSnapshot.parse({
    protocol: 'R05_COMMERCIAL_ORIGIN_V1', clientId: input.clientId,
    revision: (previous?.snapshot.revision ?? 0) + 1, predecessorId: previous?.id ?? null,
    acquiredById: input.acquiredById, contractedById: input.contractedById,
    sourceReference: input.sourceReference, reason: input.reason,
  });
  const entry = await tx.auditLog.create({ data: {
    actorId: actor.userId, entityType: 'Client', entityId: input.clientId,
    event: previous ? commercialOriginEvents[1] : commercialOriginEvents[0],
    // Strict chronology survives simultaneous timestamps and preserves every previous record.
    createdAt: new Date(Math.max(Date.now(), (previous?.createdAt.getTime() ?? 0) + 1)),
    before: previous ? encodeCommercialOrigin(previous.snapshot) : Prisma.JsonNull, after: encodeCommercialOrigin(after),
  } });
  decode(entry, input.clientId); // A stored snapshot must remain readable, or the whole transaction rolls back.
  return entry;
}
