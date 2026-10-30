export const dynamic='force-dynamic';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listAdminOperationalSources } from '@/lib/admin-operational-lifecycle';
import { adminOperationalModels, adminOperationalModelLabels, adminOperationalStates, adminOperationalLabels } from '@/lib/admin-operational-state';
import { PageHeader } from '@/components/ui';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const session=await requireSession();if(session.role!=='admin')notFound();
  const query=await searchParams;
  const parsed=z.object({model:z.enum(adminOperationalModels).default('ControlledIntake'),state:z.enum([...adminOperationalStates,'ALL']).default('ALL'),
    query:z.string().trim().max(128).default(''),page:z.coerce.number().int().min(1).max(10000).default(1)}).safeParse(query);
  if(!parsed.success)notFound();
  const data=await listAdminOperationalSources(prisma,session,parsed.data);
  const pageHref=(page:number)=>'?'+new URLSearchParams({model:data.model,state:data.state,query:data.query,page:String(page)});
  return <div className="crm-space-y-6"><PageHeader title="Stato delle schede operative" description="Gestisci blocco, archivio, cestino e ripristino delle fonti conservate."/>
    <Link className="underline" href="/admin/records">Dati e correzioni amministrative</Link>
    <form className="grid gap-3 md:grid-cols-3">
      <label>Area<select aria-label="Area" name="model" defaultValue={data.model} className="block w-full rounded-xl border p-3">
        {adminOperationalModels.map(model=><option key={model} value={model}>{adminOperationalModelLabels[model]}</option>)}</select></label>
      <label>Stato<select aria-label="Stato" name="state" defaultValue={data.state} className="block w-full rounded-xl border p-3">
        <option value="ALL">Tutti</option>{adminOperationalStates.map(state=><option key={state} value={state}>{adminOperationalLabels[state]}</option>)}</select></label>
      <label>Cerca per riferimento<input name="query" defaultValue={data.query} maxLength={128} className="block w-full rounded-xl border p-3"/></label>
      <button className="rounded-xl bg-blue-900 px-4 py-3 font-bold text-white">Mostra schede</button>
    </form>
    <p>Ogni riga è verificata nel suo contesto corrente. Puoi aprire questa gestione anche direttamente dalla scheda.</p>
    <ul className="space-y-3">{data.records.map(record=><li key={record.id} className="rounded-xl border p-4">
      <Link className="font-bold underline" href={'/admin/lifecycle/'+data.model+'/'+encodeURIComponent(record.id)}>{record.label}</Link>
      <p>{adminOperationalLabels[record.state]}</p><Link className="underline" href={record.href}>Apri nel contesto</Link>
    </li>)}</ul>
    {!data.records.length&&<p>Nessuna scheda accessibile in questa pagina.</p>}
    <nav aria-label="Pagine delle schede">{data.page>1&&<Link className="mr-4 underline" href={pageHref(data.page-1)}>Pagina precedente</Link>}
      {data.hasMore&&<Link className="underline" href={pageHref(data.page+1)}>Pagina successiva</Link>}</nav>
  </div>;
}
