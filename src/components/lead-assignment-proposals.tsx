import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import type { AuthSession } from '@/lib/auth';
import { hasPermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { leadAssignees } from '@/lib/lead-assignee';
import { privilegedAccessReadiness } from '@/lib/privileged-access';
import { Card,formatDateTime } from './ui';
import { LeadAssignmentProposalForm } from './lead-assignment-proposal-form';
export async function LeadAssignmentProposals({session,leadId,assignedToId,version}:{session:AuthSession;leadId:string;assignedToId:string|null;version:number}) {
  if(session.role!=='admin'&&session.userId!==assignedToId) return null;
  const [rows,users]=await Promise.all([prisma.leadAssignmentProposal.findMany({where:{leadId},orderBy:{createdAt:'desc'},take:20}),leadAssignees(prisma)]);
  const readiness=session.role==='admin' ? await privilegedAccessReadiness(session,'N14_LEAD_INBOX_ASSIGN') : null;
  const ids=[...new Set(rows.flatMap(r=>[r.proposedById,r.targetUserId,...(r.decidedById?[r.decidedById]:[])]))];
  const names=await prisma.user.findMany({where:{id:{in:ids}},select:{id:true,name:true}});
  const name=(id:string|null)=>names.find(u=>u.id===id)?.name??'Utente storico';
  return <Card title="Qualificazione e proposta del referente">
    <p>La proposta mantiene il lavoro al referente corrente. La decisione dell’Admin rende subito operativo il nuovo incarico.</p>
    {session.userId===assignedToId&&hasPermission(session,'lead.write')&&<LeadAssignmentProposalForm id={randomUUID()} leadId={leadId} version={version} users={users}/>}
    {rows.map(row=><article className="my-3 rounded-xl border p-3" key={row.id}><p>{name(row.proposedById)} propone {name(row.targetUserId)} · {formatDateTime(row.createdAt)}</p><p>{row.reason}</p>
      <p>{({PENDING:'Da confermare',CONFIRMED:'Confermata',SUPERSEDED:'Superata'})[row.state]??row.state}{row.decidedAt&&` · ${name(row.decidedById)} · ${formatDateTime(row.decidedAt)}`}</p>
      {session.role==='admin'&&row.state==='PENDING'&&<>{readiness?.active ? <LeadAssignmentProposalForm id={row.id} leadId={leadId} version={row.inboxVersion} users={users} confirm={{targetUserId:row.targetUserId,reason:row.reason}}/> : <p><Link className="underline" href="/settings/security?returnTo=lead-inbox">Conferma identità per assegnare</Link></p>}<Link className="underline" href={'/leads/inbox?lead='+encodeURIComponent(leadId)}>Scegli un altro referente</Link></>}
    </article>)}
  </Card>;
}
