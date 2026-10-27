import { timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { loadActivePrivilegedStepUpKey, lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { privilegedAccessMode } from './application-security-policy';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { lockAuthoritativeInternalSession, lockInternalUser, tokenDigestFromCookie } from './internal-session-registry';
import { verifiedPrivilegedStepUpExpiry, type PrivilegedStepUpKey } from './privileged-step-up-token';
import { hasPermission } from './permission-evaluator';
import { internalSessionMode } from './session';
import { withSerializableTransaction } from './serializable';
import { loadPersonalSelectiveProjectScope, loadSelectiveProjectScope, loadTechnicalAssignmentIndependentScope } from './selective-project-scope';
import { admitsTechnicalAssignmentManager, admitsTechnicalRolePermission } from './technical-assignment-permissions';
import type { TechnicalAssignmentSelection } from './technical-assignment-contract';
import { TechnicalAssignmentError } from './technical-assignment-errors';
export { TechnicalAssignmentError } from './technical-assignment-errors';

type Tx = Prisma.TransactionClient;
type Kind = TechnicalAssignmentSelection['kind'];
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const authoritySchema = z.object({ id:z.literal('technical-assignment'),userId:identifier,
  revision:z.number().int().positive().max(2_147_483_647),enabled:z.boolean() }).strict();
type Authority = z.infer<typeof authoritySchema>;
export type TechnicalAssignmentPersonalProof = { key:PrivilegedStepUpKey;sessionToken:string;stepUpToken:string };
function deny():never { throw new TechnicalAssignmentError('DENIED'); }
export async function technicalAssignmentClock(tx:Tx) {
  const [row]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;
  if (!row || !Number.isFinite(row.now.getTime())) throw new TechnicalAssignmentError('UNAVAILABLE');
  return row.now;
}
async function user(tx:Tx,id:string) {
  const row=await tx.user.findUnique({where:{id},include:{permissionOverrides:true}});
  if(!row) deny();
  return row;
}
type CurrentSession=AuthSession & {registryExpiresAt:Date};
export type TechnicalAssignmentTransaction = {
  current:CurrentSession; key:PrivilegedStepUpKey; authority:Authority;
  author:Awaited<ReturnType<typeof user>>; actor:Awaited<ReturnType<typeof user>>;
  recipient:Awaited<ReturnType<typeof user>>|null;
  personalProofExpiresAt?:number;
};
async function assertSessionTime(tx:Tx,current:CurrentSession) {
  const now=await technicalAssignmentClock(tx);
  if(!Number.isFinite(current.expiresAt) || current.expiresAt*1000<=now.getTime()
    || current.registryExpiresAt<=now) deny();
  return now;
}
async function assertPersonal(tx:Tx,current:CurrentSession,proof:TechnicalAssignmentPersonalProof) {
  const now=await assertSessionTime(tx,current);
  const session=await tx.internalSession.findUnique({where:{id:current.sessionId!},select:{tokenDigest:true}});
  const digest=await tokenDigestFromCookie(proof.sessionToken);
  const proofExpiresAt=verifiedPrivilegedStepUpExpiry({
      key:proof.key,expectedUserId:current.userId,sessionToken:proof.sessionToken,token:proof.stepUpToken,
      nowSeconds:Math.floor(now.getTime()/1000) });
  if(privilegedAccessMode()!=='enforced' || !session || !digest || digest.length!==session.tokenDigest.length
    || !timingSafeEqual(digest,session.tokenDigest) || !proofExpiresAt) deny();
  return proofExpiresAt;
}

/** Shared current admission for management and assigned work routes.
 * The distinct personal authority is never created by this code.
 * Missing/disabled authority fails closed; no fallback to sharing/email bindings.
 * The callback must still lock and verify the target, assignment journal,
 * document scope and exact command before any projection or mutation. */
async function withTransaction<T>(db:PrismaClient,claimed:AuthSession,kind:Kind,recipientId:string|null,
  mode:'MANAGEMENT_READ'|'PERSONAL_DECISION'|'RECIPIENT',proof:TechnicalAssignmentPersonalProof|null,
  work:(tx:Tx,state:TechnicalAssignmentTransaction)=>Promise<T>,inactiveRecipientForRevocation=false) {
  identifier.parse(claimed.userId);
  if(recipientId) identifier.parse(recipientId);
  if(!['Project','TechnicalPractice'].includes(kind)) deny();
  if(mode==='PERSONAL_DECISION' && !proof) deny();
  if(inactiveRecipientForRevocation && mode==='RECIPIENT') deny();
  return withSerializableTransaction(db,async tx=>{
    if(internalSessionMode()!=='registry' || !z.string().uuid().safeParse(claimed.sessionId).success) deny();
    const key=proof?.key ?? await loadActivePrivilegedStepUpKey(tx);
    if(!key || !await lockRegisteredPrivilegedStepUpKey(tx,key)) throw new TechnicalAssignmentError('UNAVAILABLE');
    await lockCommunicationDirectory(tx);
    const rows=await tx.$queryRaw<Authority[]>`
      SELECT id,"userId",revision,enabled FROM "TechnicalAssignmentAuthority"
      WHERE id='technical-assignment' FOR SHARE`;
    const parsed=authoritySchema.safeParse(rows[0]);
    if(!parsed.success || !parsed.data.enabled) deny();
    const authority=parsed.data;
    for(const id of [...new Set([authority.userId,claimed.userId,...(recipientId?[recipientId]:[])])].sort())
      await lockInternalUser(tx,id);
    const live=await lockAuthoritativeInternalSession(tx,{userId:claimed.userId,sessionId:claimed.sessionId!});
    if(!live || !live.active || live.deletedAt || live.revokedAt || !live.live) deny();
    const current:CurrentSession={...claimed,role:live.role,active:live.active,
      permissionOverrides:[...live.permissionOverrides],registryExpiresAt:live.expiresAt,
      ...await (mode==='RECIPIENT' ? loadTechnicalAssignmentIndependentScope
        : inactiveRecipientForRevocation ? loadPersonalSelectiveProjectScope : loadSelectiveProjectScope)(tx,claimed.userId)};
    const author=await user(tx,authority.userId),actor=await user(tx,claimed.userId);
    const recipient=recipientId ? await user(tx,recipientId) : null;
    if(!author.active || author.deletedAt || !admitsTechnicalAssignmentManager(author,kind)) deny();
    if(mode==='RECIPIENT') {
      if(!recipient || recipient.id!==current.userId || !admitsTechnicalRolePermission(current,kind)) deny();
    } else if(current.userId!==authority.userId || !admitsTechnicalAssignmentManager(current,kind)) deny();
    if(recipient && !inactiveRecipientForRevocation && (!recipient.active || recipient.deletedAt
      || recipient.id===authority.userId || !admitsTechnicalRolePermission(recipient,kind))) deny();
    await assertSessionTime(tx,current);
    const personalProofExpiresAt=proof ? await assertPersonal(tx,current,proof) : undefined;
    const result=await work(tx,{current,key,authority,author,actor,recipient,personalProofExpiresAt});
    await assertSessionTime(tx,current);
    if(proof) await assertPersonal(tx,current,proof);
    return result;
  });
}

/** Read-only management loaders must keep their callbacks free of writes. */
export function withTechnicalAssignmentManagementRead<T>(db:PrismaClient,claimed:AuthSession,kind:Kind,
  recipientId:string|null,work:(tx:Tx,state:TechnicalAssignmentTransaction)=>Promise<T>,
  options:{inactiveRecipientForRevocation?:true}={}) {
  return withTransaction(db,claimed,kind,recipientId,'MANAGEMENT_READ',null,work,options.inactiveRecipientForRevocation);
}
export function withTechnicalAssignmentDecision<T>(db:PrismaClient,claimed:AuthSession,kind:Kind,
  recipientId:string,proof:TechnicalAssignmentPersonalProof,work:(tx:Tx,state:TechnicalAssignmentTransaction)=>Promise<T>,
  options:{inactiveRecipientForRevocation?:true}={}) {
  return withTransaction(db,claimed,kind,recipientId,'PERSONAL_DECISION',proof,work,options.inactiveRecipientForRevocation);
}
export function withTechnicalAssignmentRecipient<T>(db:PrismaClient,claimed:AuthSession,kind:Kind,
  work:(tx:Tx,state:TechnicalAssignmentTransaction)=>Promise<T>) {
  return withTransaction(db,claimed,kind,claimed.userId,'RECIPIENT',null,work);
}

/** Private creation has no recipient and creates no assignment. It still uses
 * the existing personal authority, current step-up, directory/session locks and
 * the additional service.write ceiling. */
export function withTechnicalPrivateItemDecision<T>(db:PrismaClient,claimed:AuthSession,kind:Kind,
  proof:TechnicalAssignmentPersonalProof,work:(tx:Tx,state:TechnicalAssignmentTransaction)=>Promise<T>) {
  return withTransaction(db,claimed,kind,null,'PERSONAL_DECISION',proof,async(tx,state)=>{
    if(state.recipient || !hasPermission(state.current,'service.write')
      || state.current.permissionOverrides.some(p=>p.permission==='service.write' && !p.allowed)) deny();
    return work(tx,state);
  });
}
