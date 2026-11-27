'use client';
import { useActionState, useId, useState } from 'react';
import { saveLeadAssignmentProposal } from '@/lib/lead-assignment-proposal-actions';
export function LeadAssignmentProposalForm({id,leadId,version,users,confirm}:{id:string;leadId:string;version:number;users:{id:string;name:string;email:string}[];confirm?:{targetUserId:string;reason:string}}) {
  const [state,action,pending]=useActionState(saveLeadAssignmentProposal,{ok:false,message:''});
  const [commandId,setCommandId]=useState(id);
  const [target,setTarget]=useState('');
  const [reason,setReason]=useState('');
  const targetId=useId(), reasonId=useId();
  return <form action={action} className="grid gap-3">
    <input type="hidden" name="id" value={confirm?id:commandId}/><input type="hidden" name="leadId" value={leadId}/>
    <input type="hidden" name="expectedInboxVersion" value={version}/><input type="hidden" name="decision" value={confirm?'confirm':'propose'}/>
    {confirm?<><input type="hidden" name="targetUserId" value={confirm.targetUserId}/><input type="hidden" name="reason" value={confirm.reason}/></>:<>
      <div><label htmlFor={targetId}>Commerciale proposto</label><select id={targetId} name="targetUserId" required className="block w-full rounded-xl border p-3" value={target} onChange={event=>{setTarget(event.target.value);setCommandId(crypto.randomUUID());}}><option value="" disabled>Scegli una persona abilitata</option>{users.map(u=><option value={u.id} key={u.id}>{u.name} · {u.email}</option>)}</select></div>
      <div><label htmlFor={reasonId}>Sintesi della qualificazione</label><textarea id={reasonId} name="reason" required minLength={3} maxLength={500} className="block w-full rounded-xl border p-3" value={reason} onChange={event=>{setReason(event.target.value);setCommandId(crypto.randomUUID());}}/></div></>}
    <button className="rounded-xl bg-fai-green p-3 font-bold text-white" disabled={pending}>{confirm?'Conferma assegnazione':'Proponi all’Admin'}</button>
    {state.message&&<p role="status">{state.message}</p>}
  </form>;
}
