import type { Prisma } from '@prisma/client';
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const rowSchema = z.object({ id: z.string().uuid(), kind: z.enum(['Project', 'TechnicalPractice']),
  projectId: id.nullable(), practiceId: id.nullable() }).strict();

/** Permanent restrictions, not admissions. Expiry, revocation, disabled binding
 * or corrupt proof never restores a broader legacy owner-based route. The new
 * signed operational loader checks its own current grant separately. */
export async function loadTechnicalAssignmentExclusions(tx: Prisma.TransactionClient, recipientId: string) {
  id.parse(recipientId);
  const raw = await tx.$queryRaw<unknown[]>`SELECT id,kind,"projectId","practiceId"
    FROM "TechnicalAssignment" WHERE "recipientId"=${recipientId} ORDER BY id`;
  const rows = raw.map(value => rowSchema.parse(value));
  if (rows.some(row => row.kind === 'Project' ? !row.projectId || row.practiceId !== null : !row.practiceId || row.projectId !== null)) {
    throw new Error('TECHNICAL_ASSIGNMENT_EXCLUSION_UNAVAILABLE');
  }
  const history = rows.length ? await tx.$queryRaw<Array<{ id: string; commandId: string }>>`
    SELECT h.id,h."commandId" FROM "TechnicalAssignmentRevision" h
    JOIN "TechnicalAssignment" a ON a.id=h."assignmentId" WHERE a."recipientId"=${recipientId}` : [];
  const work = rows.length ? await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "TechnicalWorkCommand" WHERE "actorId"=${recipientId}` : [];
  // A technical responsibility never permits the general customer dossier.
  // Reuse its entire indirect-resource ceiling, including unselected documents,
  // instead of allowing an old consultant relationship to bypass the new scope.
  const clients = rows.length ? await tx.$queryRaw<Array<{ clientId: string }>>`
    SELECT DISTINCT COALESCE(p."clientId",t."clientId") AS "clientId" FROM "TechnicalAssignment" a
    LEFT JOIN "Project" p ON p.id=a."projectId" LEFT JOIN "TechnicalPractice" t ON t.id=a."practiceId"
    WHERE a."recipientId"=${recipientId}` : [];
  for (const client of clients) id.parse(client.clientId);
  return { projectIds: rows.flatMap(row => row.projectId ? [row.projectId] : []),
    clientIds: clients.map(row => row.clientId),
    practiceIds: rows.flatMap(row => row.practiceId ? [row.practiceId] : []),
    auditIds: [...rows.map(row => row.id), ...history.flatMap(row => [row.id, row.commandId]), ...work.map(row => row.id)] };
}
