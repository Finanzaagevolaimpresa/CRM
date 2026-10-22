import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { readTechnicalAssignmentProof, technicalAssignmentPayload, technicalAssignmentProof, type CurrentTechnicalAssignmentProof } from './technical-assignment-proof';

const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const generation=z.number().int().positive().max(2_147_483_647);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const technicalAssignmentReceipt=z.object({
  protocol:z.literal('TECHNICAL_ASSIGNMENT_RECEIPT_V1'),commandId:z.string().uuid(),assignmentId:z.string().uuid(),
  revisionId:z.string().uuid(),revision:generation,operation:z.enum(['ASSIGN','REVOKE']),
  fieldCount:z.number().int().min(1).max(12),actionCount:z.number().int().min(1).max(6),
  documentCount:z.number().int().min(0).max(20),keyVersion:generation,
}).strict();
const journalSchema=z.object({
  assignment:z.object({payload:technicalAssignmentPayload,proof:hash,revokedAt:z.string().datetime().nullable()}).strict(),
  decision:z.object({id:z.string().uuid(),actorId:id,sessionId:z.string().uuid(),
    kind:z.enum(['Project','TechnicalPractice']),targetId:id,recipientId:id,
    expectedRevision:z.number().int().nonnegative().max(2_147_483_646),operation:z.enum(['ASSIGN','REVOKE']),
    requestDigest:hash,receipt:technicalAssignmentReceipt,receiptProof:hash,transactionId:z.bigint().positive()}).strict(),
  revision:z.object({id:z.string().uuid(),assignmentId:z.string().uuid(),revision:generation,commandId:z.string().uuid(),
    payload:technicalAssignmentPayload,proof:hash,revokedAt:z.string().datetime().nullable(),transactionId:z.bigint().positive()}).strict(),
  audit:z.object({id:z.string().uuid(),actorId:id,event:z.literal('technical_assignment_changed'),
    entityType:z.literal('TechnicalAssignmentRevision'),entityId:z.string().uuid(),before:z.unknown(),after:z.unknown()}).strict(),
}).strict();

/** Read admission needs the persisted decision, version and minimized audit to
 * agree with the currently locked assignment. A signed selection by itself is
 * insufficient. The caller must supply fresh DB facts, never submitted JSON.
 * No history is written, repaired or inferred here. */
export function readTechnicalAssignmentJournal(raw:unknown,key:PrivilegedStepUpKey,
  current:CurrentTechnicalAssignmentProof,now:Date) {
  try {
    const row=journalSchema.parse(raw),d=row.decision,h=row.revision,a=row.audit,r=d.receipt;
    const p=readTechnicalAssignmentProof(row.assignment,key,current,now);
    if(!p || d.operation!=='ASSIGN' || d.id!==p.commandId || d.actorId!==p.approvedById
      || d.kind!==p.selection.kind || d.targetId!==p.targetId || d.recipientId!==p.selection.userId
      || d.expectedRevision+1!==p.revision || h.id!==r.revisionId || h.assignmentId!==p.id
      || h.revision!==p.revision || h.commandId!==d.id || h.transactionId!==d.transactionId
      || h.revokedAt!==null || h.proof!==row.assignment.proof
      || canonicalSha256(h.payload)!==canonicalSha256(p)
      || r.commandId!==d.id || r.assignmentId!==p.id || r.revision!==p.revision || r.operation!=='ASSIGN'
      || r.fieldCount!==p.selection.readableFields.length || r.actionCount!==p.selection.actions.length
      || r.documentCount!==p.selection.documents.length || r.keyVersion!==p.keyVersion || r.keyVersion!==key.version
      || a.id!==h.id || a.entityId!==h.id || a.actorId!==p.approvedById
      || canonicalSha256(a.before)!==canonicalSha256({version:d.expectedRevision})
      || canonicalSha256(a.after)!==canonicalSha256({version:p.revision,action:'ASSIGN',
        fieldCount:r.fieldCount,actionCount:r.actionCount,documentCount:r.documentCount})) return null;
    const proof=technicalAssignmentProof(key,'receipt',r);
    if(!timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(d.receiptProof,'hex'))) return null;
    return p;
  } catch { return null; }
}
