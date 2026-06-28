export const dynamic = 'force-dynamic';
import { DisabledAction, Hint, PrimaryButton, SecondaryLink } from '@/components/actions';
import { uploadDocumentAndRefresh } from '@/lib/form-actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table, formatDateTime } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { hasPermission, requirePermission } from '@/lib/auth';
import { canViewDocument, isSensitiveDocument } from '@/lib/access-control';
import { privateDocumentExists } from '@/lib/storage';

const serviceAreas = ['anagrafica','bancabilita','finanziamento_aziendale','bandi_finanza_agevolata','progetto_investimento','contratti','pagamenti','dossier','output_ai','altro'];

export default async function Page() {
  const session = await requirePermission('document.download');
  const [documentItems, clientRows, projectRows, serviceRows, userRows] = await Promise.all([
    prisma.document.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.project.findMany({ where: { deletedAt: null } }),
    prisma.clientService.findMany({ where: { deletedAt: null } }),
    prisma.user.findMany({ where: { active: true } }),
  ]);
  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const projectById = new Map(projectRows.map((p) => [p.id, { ...p, client: clientById.get(p.clientId) }]));
  const serviceById = new Map(serviceRows.map((service) => [service.id, service]));
  const canReadSensitive = hasPermission(session, 'document.sensitive.read');
  const visible = documentItems.filter((document) => canViewDocument(session, { ...document, client: document.clientId ? clientById.get(document.clientId) : null, project: document.projectId ? projectById.get(document.projectId) : null, clientService: document.clientServiceId ? serviceById.get(document.clientServiceId) : null }, canReadSensitive));
  const availability = new Map(await Promise.all(visible.map(async (d) => [d.id, await privateDocumentExists(d.storagePath)] as const)));
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  const users = new Map(userRows.map((u) => [u.id, u.name]));

  return <div className="space-y-6"><PageHeader title="Documenti" description="Upload reale in storage locale privato: nessun file è pubblico, ogni download passa da permessi e audit log."/>
    <Card title="Carica documento reale"><form action={uploadDocumentAndRefresh} className="grid gap-3 md:grid-cols-4">
      <input className="rounded-xl border p-3 md:col-span-2" type="file" name="file" required />
      <input className="rounded-xl border p-3 md:col-span-2" name="title" placeholder="Titolo documento" required />
      <select className="rounded-xl border p-3" name="clientId" required><option value="">Cliente</option>{clientRows.map(c=><option key={c.id} value={c.id}>{c.displayName}</option>)}</select>
      <select className="rounded-xl border p-3" name="projectId"><option value="">Progetto opzionale</option>{projectRows.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select>
      <select className="rounded-xl border p-3" name="clientServiceId"><option value="">Servizio opzionale</option>{serviceRows.map(s=><option key={s.id} value={s.id}>{clients.get(s.clientId) ?? 'Cliente'} · {s.id}</option>)}</select>
      <select className="rounded-xl border p-3" name="serviceArea" defaultValue="altro">{serviceAreas.map(a=><option key={a} value={a}>{a}</option>)}</select>
      <input className="rounded-xl border p-3" name="documentCategory" placeholder="Categoria" defaultValue="altro" />
      <input className="rounded-xl border p-3" name="validUntil" type="date" />
      <label className="flex items-center gap-2 rounded-xl border p-3 text-sm font-bold"><input type="checkbox" name="containsSensitiveData" value="true" /> Sensibile</label>
      <PrimaryButton type="submit" className="md:col-span-4">Carica in storage privato</PrimaryButton>
    </form><Hint>I file vengono salvati in <code>storage/private/documents</code> solo lato server; lo storagePath non è esposto all’utente.</Hint></Card>
    <Card title="Elenco operativo">{visible.length === 0 ? <EmptyState title="Nessun elemento presente" /> : <Table headers={['Documento', 'Cliente/Progetto', 'Sezione', 'Categoria', 'Tracciabilità', 'Scadenza', 'Download']} rows={visible.map((x) => { const ok = availability.get(x.id); return [<span className='font-semibold text-fai-navy' key='n'>{x.title}<br/><span className="text-xs font-normal text-slate-500">{x.fileName}{!ok ? ' · metadata demo / file non caricato' : ''}</span></span>, <span key="cp">{x.clientId ? clients.get(x.clientId) ?? '—' : '—'}<br/>{x.projectId ? projects.get(x.projectId) : ''}</span>, x.serviceArea, <span key='c'>{x.documentCategory} {isSensitiveDocument(x) ? <span className='ml-2 rounded-full bg-fai-orange/10 px-2 py-0.5 text-xs font-bold text-fai-orange'>sensibile</span> : null}<br/><StatusBadge status={x.status} /></span>, <MetaCell key='m' createdAt={x.createdAt} updatedAt={x.updatedAt} owner={users.get(x.uploadedById)} />, formatDateTime(x.validUntil), ok ? <SecondaryLink key="d" href={`/documents/${x.id}/download`}>Scarica</SecondaryLink> : <DisabledAction key='d' reason='File fisico assente nello storage privato'>File non caricato</DisabledAction>]; })} />}</Card>
  </div>;
}
