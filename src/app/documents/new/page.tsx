import { notFound } from 'next/navigation';
import { requirePermission, hasPermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canEditClient, canEditProject, canEditService, canViewClient } from '@/lib/access-control';
import { selectDocumentUploadContext, type UploadContextQuery } from '@/lib/document-upload-context';
import { canAccessFinancialDocumentMetadata } from '@/lib/financial-access';
import { DocumentUploadForm } from '@/components/document-upload-form';
import { Card, PageHeader } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<UploadContextQuery> }) {
  const session = await requirePermission('document.upload'), query = await searchParams;
  const [clients, projects, services, companies] = await Promise.all([
    prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } }),
    prisma.clientService.findMany({ where: { deletedAt: null } }), prisma.company.findMany({ where: { deletedAt: null } }),
  ]);
  const clientMap = new Map(clients.map(row => [row.id, row]));
  const projectMap = new Map(projects.map(row => [row.id, { ...row, client: clientMap.get(row.clientId) }]));
  const writableProjects = projects.filter(row => canEditProject(session, projectMap.get(row.id)!));
  const writableServices = services.filter(row => canEditService(session, { ...row, client: clientMap.get(row.clientId) ?? null,
    project: row.projectId ? projectMap.get(row.projectId) ?? null : null }));
  const children = new Set([...writableProjects, ...writableServices].map(row => row.clientId));
  const writableClients = clients.filter(row => canEditClient(session, row) || children.has(row.id))
    .map(row => ({ ...row, generalUploadAllowed: canEditClient(session, row) }));
  const context = (() => { try { return selectDocumentUploadContext(query, { clients: writableClients, projects: writableProjects, services: writableServices }); }
    catch { return notFound(); } })();
  const client = writableClients.find(row => row.id === context.clientId)!;
  const project = writableProjects.find(row => row.id === context.projectId), service = writableServices.find(row => row.id === context.clientServiceId);
  const areas = ['anagrafica', 'bancabilita', 'finanziamento_aziendale', 'bandi_finanza_agevolata', 'progetto_investimento', 'contratti', 'pagamenti', 'dossier', 'output_ai', 'altro'];
  return <div className="crm-space-y-6"><PageHeader title="Carica documenti nel contesto" description="Controlla i collegamenti prima di scegliere i file. Il salvataggio rilegge i tuoi permessi correnti."/>
    <div className="flex flex-wrap gap-3">{canViewClient(session, client) && <SecondaryLink href={`/clients/${client.id}`}>Torna al fascicolo</SecondaryLink>}
      {hasPermission(session, 'document.download') && <SecondaryLink href="/documents">Documenti consentiti</SecondaryLink>}</div>
    <Card title="Contesto del caricamento"><p>Cliente: <strong>{client.displayName}</strong></p>
      <p>Progetto iniziale: {project?.title ?? 'Non selezionato'}</p><p>Servizio iniziale: {service?.practiceType ?? (service ? 'Servizio del cliente' : 'Fascicolo generale')}</p>
      <p className="mt-3">Nel percorso ordinario il materiale è disponibile secondo i permessi già esistenti sul documento e sul contesto. Un incarico selettivo richiede la scelta delle singole versioni da parte dell’Admin, con download separato. Il caricamento non crea una concessione.</p>
      <p className="mt-3">Contratti, pagamenti e archivi riservati restano accessibili soltanto ad Admin e Amministrazione. I progetti o servizi non selezionabili richiedono l’intervento dell’Admin per il collegamento.</p>
    </Card>
    <Card title="File e collegamenti"><DocumentUploadForm fixedClientId={context.clientId} initialProjectId={context.projectId} initialServiceId={context.clientServiceId}
      clients={[{ id: client.id, clientId: client.id, label: client.displayName, generalUploadAllowed: client.generalUploadAllowed }]}
      companies={client.generalUploadAllowed ? companies.filter(row => row.clientId === client.id).map(row => ({ id: row.id, clientId: row.clientId, label: row.name })) : []}
      projects={writableProjects.filter(row => row.clientId === client.id).map(row => ({ id: row.id, clientId: row.clientId, label: row.title }))}
      services={writableServices.filter(row => row.clientId === client.id).map(row => ({ id: row.id, clientId: row.clientId, label: row.practiceType ?? 'Servizio del cliente' }))}
      serviceAreas={areas.filter(serviceArea => canAccessFinancialDocumentMetadata(session, { serviceArea }))}/></Card>
  </div>;
}
