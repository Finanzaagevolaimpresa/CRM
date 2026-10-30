import Link from 'next/link';
import {randomUUID} from 'node:crypto';
import {notFound} from 'next/navigation';
import {z} from 'zod';
import {requireSession} from '@/lib/auth';
import {prisma} from '@/lib/prisma';
import {readAdminDraftReplacement,listAdminDraftTargets} from '@/lib/admin-draft-context';
import {ApprovedCommunicationError} from '@/lib/approved-communication-contract';
import {RecordUpdateError} from '@/lib/record-update-contract';
import {AdminOperationalStateError} from '@/lib/admin-operational-state';
import {AdminDraftContextForm} from '@/components/admin-draft-context-form';
export const dynamic='force-dynamic';
const labels={CLIENT:'Clienti',LEAD:'Lead',READINESS:'Pratiche preventivo e avvio',TECHNICAL:'Pratiche tecniche',INTERNAL:'Conversazioni interne'};
export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{kind?:string;q?:string;page?:string;command?:string}>}){
  const session=await requireSession();if(session.role!=='admin')notFound();
  const {id}=await params,q=await searchParams;if(!z.string().uuid().safeParse(id).success)notFound();
  if(q.command&&!z.string().uuid().safeParse(q.command).success)notFound();
  let source;
  try{source=await readAdminDraftReplacement(prisma,session,id);}
  catch(error){if(error instanceof ApprovedCommunicationError||error instanceof RecordUpdateError||error instanceof AdminOperationalStateError)notFound();throw error;}
  const parsed=z.object({kind:z.enum(['CLIENT','LEAD','READINESS','TECHNICAL','INTERNAL']),query:z.string().max(128),page:z.number().int().min(1).max(10000)})
    .safeParse({kind:q.kind??'CLIENT',query:q.q??'',page:Number(q.page??1)});
  if(!parsed.success)notFound();
  const targets=!q.command&&source.eligible?await listAdminDraftTargets(prisma,session,parsed.data):null;
  const path='/admin/communication-drafts/'+id;
  function pageHref(page:number){return path+'?'+new URLSearchParams({kind:parsed.success?parsed.data.kind:'CLIENT',q:q.q??'',page:String(page)});}
  return <main className="space-y-5"><h1 className="text-2xl font-bold">Correggi il contesto di una bozza</h1>
    <Link className="underline" href={source.sourceHref}>Apri la comunicazione originale</Link>
    <section className="rounded-xl border p-4"><h2 className="font-bold">{source.subject}</h2>
      <p>Una sostituzione conserva la fonte e archivia l’originale. Nel nuovo contesto rivedi il testo e seleziona mittente, destinatari e versioni degli allegati.</p>
      <p>Le comunicazioni con approvazioni, invii, risposte o origini vincolate mantengono il proprio percorso e il proprio storico.</p></section>
    {source.links.length>0&&<section className="rounded-xl border p-4 space-y-3"><h2 className="font-bold">Originale e sostituzioni conservate</h2>
      <ul>{source.links.map(link=><li key={link.id}><Link className="underline" href={link.href}>{link.relation==='ORIGINAL'?'Apri originale':'Apri bozza sostitutiva'} · {link.label}</Link></li>)}</ul>
      <Link className="underline" href={'/admin/lifecycle/ApprovedCommunication/'+id}>Consulta tutte le decisioni e gestisci il ripristino</Link>
      {source.moreHistory&&<p>Qui sono mostrati gli ultimi 50 collegamenti; lo storico completo è disponibile nelle decisioni.</p>}</section>}
    {q.command?<AdminDraftContextForm id={id} commandId={q.command} recovering/>:!source.eligible?<p>Questa comunicazione non è una bozza operativa sostituibile. Consulta la timeline e le rettifiche amministrative.</p>:<>
      <form className="flex flex-wrap gap-3"><label>Tipo di destinazione<select name="kind" defaultValue={parsed.data.kind} className="block rounded-xl border p-2">{Object.entries(labels).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label>
        <label>Cerca destinazione<input name="q" defaultValue={parsed.data.query} maxLength={128} className="block rounded-xl border p-2"/></label><button className="underline">Cerca contesti disponibili</button></form>
      <ul className="space-y-3">{targets?.records.filter(row=>row.kind!==source.sourceContext.kind||row.id!==source.sourceContext.id).map(row=><li key={row.id} className="rounded-xl border p-3">
        <Link className="font-bold underline" href={'/communications?'+new URLSearchParams({kind:row.kind,practice:row.id,replaceDraft:id,draftCommand:randomUUID()})}>{row.label} · prepara la sostituzione</Link></li>)}</ul>
      {!targets?.records.length&&<p>Nessun contesto disponibile in questa pagina. Cambia ricerca o tipo.</p>}
      {parsed.data.page>1&&<Link className="mr-4 underline" href={pageHref(parsed.data.page-1)}>Pagina precedente</Link>}
      {targets?.hasMore&&<Link className="underline" href={pageHref(parsed.data.page+1)}>Altri contesti</Link>}
    </>}
  </main>;
}
