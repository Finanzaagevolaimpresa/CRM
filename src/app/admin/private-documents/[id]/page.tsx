export const dynamic='force-dynamic';
import { randomUUID } from 'node:crypto';
import { notFound,redirect } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readAdminPrivateDocumentMetadata } from '@/lib/admin-private-document-metadata';
import { PrivateDocumentMetadataError } from '@/lib/private-document-metadata';
import { TechnicalAssignmentError } from '@/lib/technical-assignment-transaction';
import { RecordUpdateError } from '@/lib/record-update-contract';
import { AdminPrivateDocumentMetadataEditor } from '@/components/admin-private-document-metadata-editor';
import { PageHeader } from '@/components/ui';
export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const session=await requireSession();if(session.role!=='admin')notFound();
  const {id}=await params,query=await searchParams,page=z.coerce.number().int().min(1).max(10000).safeParse(query.page??1);
  if(!page.success||!id||id.length>128)notFound();
  for(const field of ['command','decision'])if(query[field]!==undefined&&!z.string().uuid().safeParse(query[field]).success)notFound();
  if(query.decision&&query.decision!==query.command)notFound();
  const path='/admin/private-documents/'+encodeURIComponent(id);
  if(!query.command)redirect(path+'?'+new URLSearchParams({command:randomUUID(),page:String(page.data)}));
  let data;
  try{data=await readAdminPrivateDocumentMetadata(prisma,session,id,page.data);}
  catch(error){if(error instanceof PrivateDocumentMetadataError||error instanceof TechnicalAssignmentError||error instanceof RecordUpdateError||error instanceof z.ZodError)notFound();throw error;}
  return <div className="crm-space-y-6"><PageHeader title="Metadati del documento acquisito" description="Correzioni amministrative versionate, con fonte e acquisizione originali conservate."/>
    <AdminPrivateDocumentMetadataEditor key={id+':'+query.command} data={data} commandId={String(query.command)} recovering={Boolean(query.decision)}/>
  </div>;
}

