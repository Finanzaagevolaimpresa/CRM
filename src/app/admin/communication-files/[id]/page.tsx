export const dynamic = 'force-dynamic';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readAdminRecordReceipt } from '@/lib/admin-records';
import { readAdminCommunicationFile, AdminCommunicationFileError } from '@/lib/admin-communication-files';
import { ApprovedCommunicationError } from '@/lib/approved-communication-contract';
import { RecordUpdateError } from '@/lib/record-update-contract';
import { AdminCommunicationFileEditor } from '@/components/admin-communication-file-editor';
import { PageHeader } from '@/components/ui';

export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const session = await requireSession();if(session.role!=='admin')notFound();
  const {id}=await params,query=await searchParams;
  if(!z.string().uuid().safeParse(id).success)notFound();
  for(const key of ['command','version','decision'])if(query[key]!==undefined&&!z.string().uuid().safeParse(query[key]).success)notFound();
  const page=z.coerce.number().int().min(1).max(1000).safeParse(query.page??1);if(!page.success)notFound();
  if(query.decision&&query.decision!==query.command)notFound();
  if(!query.command||!query.version){
    const next=new URLSearchParams({command:String(query.command??randomUUID()),version:String(query.version??randomUUID()),page:String(page.data)});
    redirect(`/admin/communication-files/${id}?${next}`);
  }
  if(query.decision){const receipt=await readAdminRecordReceipt(prisma,session,String(query.command));
    if(receipt&&(receipt.model!=='CommunicationContextFile'||receipt.id!==query.version))notFound();}
  let data;
  try{data=await readAdminCommunicationFile(prisma,session,id,page.data);}
  catch(error){if(error instanceof AdminCommunicationFileError||error instanceof ApprovedCommunicationError||error instanceof RecordUpdateError||error instanceof z.ZodError)notFound();throw error;}
  return <div className="crm-space-y-6"><PageHeader title="Versioni e recupero dell’allegato" description="Correggi metadati, contenuto o contesto creando una nuova versione tracciata."/>
    <AdminCommunicationFileEditor key={id+':'+query.command+':'+query.version} data={data} commandId={String(query.command)}
      versionId={String(query.version)} recovering={Boolean(query.decision)}/></div>;
}
