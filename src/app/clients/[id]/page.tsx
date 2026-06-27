import { Card, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';

const serviceSections = ['Overview','Anagrafica completa','Azienda / Visura / ATECO','Titolari, soci e amministratori','Progetti','Servizi acquistati','Finanziamento aziendale','Bandi / Finanza agevolata','Bancabilità','Documenti','Pre-analisi','Dossier','Contratti','Pagamenti','Task / Scadenze','Note interne','Output AI','Audit log'];
const grantFormat = ['Stato misura:','Apertura:','Chiusura:','Risultato atteso:','Difficoltà:','Condizioni bloccanti:','Documenti richiesti:','Prossime azioni:'];
const checklist = ['Documento identità e codice fiscale','Visura camerale / assetto societario','Bilanci o dichiarazioni fiscali','Estratti conto / Centrale Rischi se disponibili','Preventivi e piano investimenti','Contratto o incarico collegato'];

function Badge({ children }: { children: React.ReactNode }) { return <span className="rounded-full bg-fai-blue/10 px-2 py-1 text-xs font-semibold text-fai-blue">{children}</span>; }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [client, companies, projects, clientServices, documents, contracts, payments, tasks, preAnalyses, dossiers, bankability, financing, aiOutputs, auditLogs] = await Promise.all([
    prisma.client.findUnique({ where: { id } }),
    prisma.company.findMany({ where: { clientId: id, deletedAt: null } }),
    prisma.project.findMany({ where: { clientId: id, deletedAt: null } }),
    prisma.clientService.findMany({ where: { clientId: id, deletedAt: null }, orderBy: { createdAt: 'desc' } }),
    prisma.document.findMany({ where: { clientId: id, deletedAt: null }, orderBy: { createdAt: 'desc' } }),
    prisma.contract.findMany({ where: { clientId: id } }),
    prisma.payment.findMany({ where: { clientId: id } }),
    prisma.task.findMany({ where: { clientId: id } }),
    prisma.preAnalysis.findMany({ where: { clientId: id } }),
    prisma.dossier.findMany({ where: { clientId: id } }),
    prisma.bankabilityAssessment.findMany({ where: { clientId: id } }),
    prisma.corporateFinancingAssessment.findMany({ where: { clientId: id } }),
    prisma.aiOutput.findMany({ where: { clientServiceId: { in: [] } }, take: 0 }),
    prisma.auditLog.findMany({ where: { OR: [{ entityId: id }, { entityType: 'ClientService' }] }, orderBy: { createdAt: 'desc' }, take: 25 }),
  ]);
  if (!client) return <h1 className="text-3xl font-bold text-fai-navy">Cliente non trovato</h1>;
  const catalog = await prisma.serviceCatalog.findMany({ where: { id: { in: clientServices.map((s) => s.serviceCatalogId) } } });
  const users = await prisma.user.findMany({ where: { id: { in: clientServices.map((s) => s.assignedToId).filter(Boolean) as string[] } } });
  const nameOf = (serviceId: string) => catalog.find((s) => s.id === serviceId)?.name ?? 'Servizio FAI';
  const userOf = (userId?: string | null) => users.find((u) => u.id === userId)?.name ?? 'Da assegnare';

  return <div className="space-y-6">
    <header><h1 className="text-3xl font-bold text-fai-navy">Fascicolo Cliente Interno — {client.displayName}</h1><p className="mt-2 text-fai-gray">Scheda operativa interna FAI: servizi acquistati, documenti per sezione, output AI in bozza con revisione umana obbligatoria e audit.</p></header>
    <div className="flex flex-wrap gap-2">{serviceSections.map((s) => <Badge key={s}>{s}</Badge>)}</div>
    <div className="grid gap-4 md:grid-cols-4"><Card title="Anagrafica"><p className="font-semibold">{client.displayName}</p><p className="text-sm text-fai-gray">Tipo: {client.type}</p><p className="text-sm text-fai-gray">Stato: {client.status}</p></Card><Card title="Aziende"><p className="text-3xl font-bold text-fai-blue">{companies.length}</p></Card><Card title="Progetti"><p className="text-3xl font-bold text-fai-blue">{projects.length}</p></Card><Card title="Servizi acquistati"><p className="text-3xl font-bold text-fai-blue">{clientServices.length}</p></Card></div>
    <Card title="Servizi acquistati"><div className="grid gap-4 md:grid-cols-2">{clientServices.map((s) => <article id={`service-${s.id}`} key={s.id} className="rounded-xl border p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-fai-navy">{nameOf(s.serviceCatalogId)}</h3><p className="text-sm text-fai-gray">Responsabile: {userOf(s.assignedToId)}</p></div><div className="flex gap-2"><Badge>{s.paymentStatus}</Badge><Badge>{s.status}</Badge></div></div><p className="mt-3 text-sm">Note interne: {s.internalNotes ?? '—'}</p><p className="mt-2 text-sm text-fai-gray">Checklist documentale predisposta: {checklist.join(' · ')}</p><h4 className="mt-3 font-semibold">Documenti collegati</h4><ul className="list-disc pl-5 text-sm">{documents.filter((d) => d.clientServiceId === s.id).map((d) => <li key={d.id}>{d.title} — {d.serviceArea} / {d.documentCategory}</li>)}{documents.filter((d) => d.clientServiceId === s.id).length === 0 && <li>Nessun documento collegato.</li>}</ul><p className="mt-2 text-sm">Output AI collegati: {aiOutputs.filter((o) => o.clientServiceId === s.id).length} — sempre bozze interne fino ad approvazione umana.</p><p className="text-sm">Task/scadenze: {tasks.filter((t) => t.clientServiceId === s.id).length}</p></article>)}</div>{clientServices.length === 0 && <p className="text-sm text-fai-gray">Nessun servizio acquistato ancora registrato.</p>}</Card>
    <Card title="Documenti per servizio e sezione"><Table headers={['Documento','Servizio','Sezione','Categoria','Stato']} rows={documents.map((d) => [d.title, d.clientServiceId ? nameOf(clientServices.find((s) => s.id === d.clientServiceId)?.serviceCatalogId ?? '') : 'Fascicolo generale', d.serviceArea, d.documentCategory, d.status])} /></Card>
    <div className="grid gap-4 lg:grid-cols-2"><Card title="Finanziamento aziendale"><p className="text-sm text-fai-gray">Area tecnica interna: importo richiesto, finalità, tempi, strumenti ordinari ipotizzabili, mutuo, chirografario, leasing, factoring, anticipo fatture, linee di credito, MCC, garanzie, fabbisogno, rata sostenibile, DSCR/cashflow, debiti, criticità, scenario A/B e prossima azione. Non promette approvazioni o finanziamenti.</p><p className="mt-3 text-sm">Valutazioni presenti: {financing.length}</p></Card><Card title="Bandi / Finanza agevolata"><p className="text-sm text-fai-gray">Ogni misura viene gestita con il formato operativo richiesto:</p><ul className="mt-2 list-disc pl-5 text-sm">{grantFormat.map((x) => <li key={x}>{x}</li>)}</ul></Card></div>
    <div className="grid gap-4 lg:grid-cols-2"><Card title="Bancabilità"><p className="text-sm">Assessment: {bankability.length}</p></Card><Card title="Pre-analisi / Dossier"><p className="text-sm">Pre-analisi: {preAnalyses.length} · Dossier: {dossiers.length}</p></Card><Card title="Contratti / Pagamenti"><p className="text-sm">Contratti: {contracts.length} · Pagamenti: {payments.length}</p></Card><Card title="Task / Scadenze"><p className="text-sm">Task aperti o storici: {tasks.length}</p></Card></div>
    <Card title="Audit log"><Table headers={['Evento','Entità','Data']} rows={auditLogs.map((a) => [a.event, `${a.entityType ?? ''} ${a.entityId ?? ''}`, a.createdAt.toISOString()])} /></Card>
  </div>;
}
