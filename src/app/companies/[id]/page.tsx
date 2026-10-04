import { Card, EmptyState, PageHeader, Table, TimestampMeta } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { SecondaryLink } from '@/components/actions';
import { hasPermission, requirePermission } from '@/lib/auth';
import { canEditClient } from '@/lib/access-control';
import { companyProfileFields } from '@/lib/record-profile-fields';
import { recordProfileValues } from '@/lib/record-profile-view';
import { getCompanyReadAccess } from '@/lib/read-access';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('company.read');
  const { id } = await params;
  const context = await getCompanyReadAccess(session, id);
  if (!context) return <PageHeader title="Azienda non trovata" description="Il record richiesto non esiste o non è accessibile." />;
  const { company } = context;
  const people = await prisma.companyPerson.findMany({ where: { companyId: id } });
  const personRows = await prisma.person.findMany({ where: { id: { in: people.map(person => person.personId) }, deletedAt: null } });
  const personById = new Map(personRows.map(person => [person.id, person]));
  const canWrite = hasPermission(session, 'company.write') && canEditClient(session, context.client);
  const values = recordProfileValues(company, companyProfileFields);
  return <div className="crm-space-y-6">
    <PageHeader title={`Azienda — ${company.name}`} description="Dati camerali, sede, ATECO, DURC, fatturato e persone collegate." />
    <SecondaryLink href={`/clients/${company.clientId}`}>← Torna al fascicolo cliente</SecondaryLink>
    {canWrite && <div className="flex flex-wrap gap-3"><SecondaryLink href={`/companies/${id}/edit`}>Modifica azienda</SecondaryLink><SecondaryLink href={`/companies/${id}/people`}>Gestisci referenti</SecondaryLink></div>}
    <Card title="Dati azienda"><Table headers={['Campo','Valore']} rows={companyProfileFields.map(field => [field.label, values[field.name] || '—'])} /><TimestampMeta createdAt={company.createdAt} updatedAt={company.updatedAt} /></Card>
    <Card id="referenti" title="Titolari, soci e amministratori">{personRows.length === 0 ? <EmptyState title="Nessuna persona collegata" /> : <Table headers={['Persona','Ruolo','Email','Telefono','Quota']} rows={people.flatMap(link => { const person = personById.get(link.personId); return person ? [[`${person.firstName} ${person.lastName}`, link.role, person.email ?? '—', person.phone ?? '—', link.ownershipPercent !== null ? `${link.ownershipPercent}%` : '—']] : []; })} />}</Card>
  </div>;
}
