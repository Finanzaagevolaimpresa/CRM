export const dynamic='force-dynamic';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readAdminOperationalState } from '@/lib/admin-operational-lifecycle';
import { operationalReference, AdminOperationalStateError } from '@/lib/admin-operational-state';
import { ApprovedCommunicationError } from '@/lib/approved-communication-contract';
import { PracticeReadinessError } from '@/lib/practice-readiness';
import { TechnicalAssignmentError } from '@/lib/technical-assignment-transaction';
import { RecordUpdateError } from '@/lib/record-update-contract';
import { AdminOperationalLifecycleEditor } from '@/components/admin-operational-lifecycle-editor';
import { PageHeader } from '@/components/ui';
export default async function Page({params,searchParams}:{
  params:Promise<{model:string;id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>;
}){
  const session=await requireSession();if(session.role!=='admin')notFound();
  const {model,id}=await params,query=await searchParams;
  try{operationalReference(model,id);}catch{notFound();}
  const page=z.coerce.number().int().min(1).max(10000).safeParse(query.page??1);if(!page.success)notFound();
  for(const field of ['command','decision'])if(query[field]!==undefined&&!z.string().uuid().safeParse(query[field]).success)notFound();
  if(query.decision&&query.decision!==query.command)notFound();
  const path='/admin/lifecycle/'+model+'/'+encodeURIComponent(id);
  if(!query.command)redirect(path+'?'+new URLSearchParams({command:randomUUID(),page:String(page.data)}));
  let data;
  try{data=await readAdminOperationalState(prisma,session,model,id,page.data);}
  catch(error){
    if(error instanceof AdminOperationalStateError||error instanceof ApprovedCommunicationError||error instanceof PracticeReadinessError
      ||error instanceof TechnicalAssignmentError||error instanceof RecordUpdateError||error instanceof z.ZodError)notFound();throw error;
  }
  return <div className="crm-space-y-6"><PageHeader title="Stato amministrativo" description="Blocca, archivia o ripristina mantenendo le fonti e le prove originali."/>
    <AdminOperationalLifecycleEditor key={model+':'+id+':'+query.command} data={data} commandId={String(query.command)} recovering={Boolean(query.decision)}/>
  </div>;
}
