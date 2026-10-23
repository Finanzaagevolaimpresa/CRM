import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import type { TechnicalAssignmentSelection } from './technical-assignment-contract';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const epoch = z.number().int().positive().max(2_147_483_647);
const base = { id, recordUpdateEpoch: epoch, deletedAt: z.date().nullable() };
const client = z.object({ ...base, salesOwnerId: id.nullable(), consultantId: id.nullable(), status:z.string().min(1) }).strict();
const project = z.object({ ...base, clientId: id, consultantId: id.nullable(), status: z.string().min(1) }).strict();
const service = z.object({ ...base, clientId: id, projectId: id.nullable(), assignedToId: id.nullable(), status: z.string().min(1) }).strict();
const practice = z.object({ ...base, clientId: id, projectId: id.nullable(), clientServiceId: id.nullable(),
  commercialOwnerId: id.nullable(), technicalOwnerId: id.nullable(), status: z.string().min(1) }).strict();
const snapshot = z.object({ kind: z.enum(['Project','TechnicalPractice']), targetId: id,
  client: client.nullable(), project: project.nullable(), service: service.nullable(), practice: practice.nullable() }).strict();
export type TechnicalContextSnapshot = z.infer<typeof snapshot>;

/** Internal context fingerprint, not a route DTO or access grant. Domain row
 * epochs preserve A→B→A changes; ordinary work fields do not change this scope. */
export function technicalAssignmentContext(raw: unknown, allowInactive = false) {
  const parsed = snapshot.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data, c = s.client, p = s.project, v = s.service, t = s.practice;
  if (!c) return null;
  if (p && p.clientId !== c.id) return null;
  if (v && (v.clientId !== c.id || (v.projectId !== null && v.projectId !== p?.id))) return null;
  if (s.kind === 'Project') {
    if (!p || p.id !== s.targetId || v || t) return null;
  } else {
    if (!t || t.id !== s.targetId || t.clientId !== c.id
        || (t.clientServiceId !== null && t.clientServiceId !== v?.id)
        || (t.clientServiceId === null && v !== null)
        || (t.projectId !== null && t.projectId !== p?.id)
        || ((t.projectId ?? v?.projectId ?? null) === null && p !== null)) return null;
  }
  const unavailable = (row: { deletedAt:Date|null;status:string }) => row.deletedAt !== null
    || ['archiviato','archiviata','sospeso'].includes(row.status);
  const operational = [c,p,v,t].filter((row):row is NonNullable<typeof row>=>row!==null).every(row=>!unavailable(row));
  if (!operational && !allowInactive) return null;
  const root = s.kind === 'Project' ? p! : t!;
  // No current status/title/text values in the fingerprint. Operational statuses
  // are validated separately; lifecycle/owner changes increment the DB epochs.
  const context = { protocol:'TECHNICAL_ASSIGNMENT_CONTEXT_V1', kind:s.kind, targetId:s.targetId,
    root:[root.id,root.recordUpdateEpoch], client:[c.id,c.recordUpdateEpoch,c.salesOwnerId,c.consultantId],
    project:p ? [p.id,p.recordUpdateEpoch,p.clientId,p.consultantId] : null,
    service:v ? [v.id,v.recordUpdateEpoch,v.clientId,v.projectId,v.assignedToId] : null,
    practice:t ? [t.id,t.recordUpdateEpoch,t.clientId,t.projectId,t.clientServiceId,t.commercialOwnerId,t.technicalOwnerId] : null };
  return { kind:s.kind, targetId:s.targetId, clientId:c.id, projectId:p?.id ?? null,
    clientServiceId:v?.id ?? null, contextSha256:canonicalSha256(context), operational };
}

const clientSelect = { id:true,recordUpdateEpoch:true,deletedAt:true,salesOwnerId:true,consultantId:true,status:true } as const;
const projectSelect = { id:true,recordUpdateEpoch:true,deletedAt:true,clientId:true,consultantId:true,status:true } as const;
const serviceSelect = { id:true,recordUpdateEpoch:true,deletedAt:true,clientId:true,projectId:true,assignedToId:true,status:true } as const;
const practiceSelect = { id:true,recordUpdateEpoch:true,deletedAt:true,clientId:true,projectId:true,clientServiceId:true,
  commercialOwnerId:true,technicalOwnerId:true,status:true } as const;

/** Call only inside the serializable assignment transaction, after the directory
 * and sorted-user/session locks. A changed row before a lock yields serialization
 * failure rather than an old scope. This helper neither writes nor grants access. */
export async function lockTechnicalAssignmentContext(tx: Prisma.TransactionClient,
  target: { kind:TechnicalAssignmentSelection['kind']; targetId:string },
  options:{writeTarget?:boolean;allowInactive?:boolean}={}) {
  const writeTarget=options.writeTarget===true;
  id.parse(target.targetId);
  if (target.kind !== 'Project' && target.kind !== 'TechnicalPractice') return null;
  const projectRef = target.kind === 'Project'
    ? await tx.project.findUnique({ where:{id:target.targetId},select:{clientId:true} }) : null;
  const practiceRef = target.kind === 'TechnicalPractice'
    ? await tx.technicalPractice.findUnique({ where:{id:target.targetId},select:{clientId:true,projectId:true,clientServiceId:true} }) : null;
  const clientId = projectRef?.clientId ?? practiceRef?.clientId;
  if (!clientId) return null;
  const initialService = practiceRef?.clientServiceId
    ? await tx.clientService.findUnique({ where:{id:practiceRef.clientServiceId},select:{projectId:true} }) : null;
  const projectIds = [...new Set([target.kind === 'Project' ? target.targetId : practiceRef?.projectId,
    initialService?.projectId].filter((x):x is string => !!x))].sort();
  await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${clientId} FOR SHARE`;
  if (projectIds.length) await tx.$queryRaw(Prisma.sql`SELECT id FROM "Project"
    WHERE id IN (${Prisma.join(projectIds)}) ORDER BY id ${Prisma.raw(writeTarget && target.kind === 'Project' ? 'FOR UPDATE' : 'FOR SHARE')}`);
  if (practiceRef?.clientServiceId) await tx.$queryRaw`SELECT id FROM "ClientService" WHERE id=${practiceRef.clientServiceId} FOR SHARE`;
  if (target.kind === 'TechnicalPractice') await tx.$queryRaw(Prisma.sql`SELECT id FROM "TechnicalPractice"
    WHERE id=${target.targetId} ${Prisma.raw(writeTarget ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const c = await tx.client.findUnique({ where:{id:clientId},select:clientSelect });
  const t = target.kind === 'TechnicalPractice'
    ? await tx.technicalPractice.findUnique({ where:{id:target.targetId},select:practiceSelect }) : null;
  const v = t?.clientServiceId ? await tx.clientService.findUnique({ where:{id:t.clientServiceId},select:serviceSelect }) : null;
  const projectId = target.kind === 'Project' ? target.targetId : t?.projectId ?? v?.projectId ?? null;
  const p = projectId ? await tx.project.findUnique({ where:{id:projectId},select:projectSelect }) : null;
  if (projectId && !projectIds.includes(projectId)) return null;
  if (t && (t.clientId !== clientId || t.clientServiceId !== practiceRef?.clientServiceId)) return null;
  const result = technicalAssignmentContext({ ...target,client:c,project:p,service:v,practice:t },options.allowInactive===true);
  return result ? { ...result, rootEpoch:(target.kind === 'Project' ? p! : t!).recordUpdateEpoch } : null;
}
