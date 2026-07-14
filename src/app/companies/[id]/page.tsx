import { Card, EmptyState, PageHeader, Table, TimestampMeta } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { SecondaryLink } from '@/components/actions';
import { requirePermission } from '@/lib/auth';
import { getCompanyReadAccess } from '@/lib/read-access';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('company.read');
  const { id } = await params;
  const context = await getCompanyReadAccess(session, id);
  if (!context) return <PageHeader title="Azienda non trovata" description="Il record richiesto non esiste o non è accessibile." />;
  const { company } = context;
  const people = await prisma.companyPerson.findMany({ where: { companyId: id } });
  return <div className="space-y-6">
    <PageHeader title={`Azienda — ${company.name}`} description="Dati camerali, sede, ATECO, DURC, fatturato e persone collegate." />
    <SecondaryLink href={`/clients/${company.clientId}`}>← Torna al fascicolo cliente</SecondaryLink>
    <Card title="Dati azienda"><Table headers={['Campo','Valore']} rows={[
      ['P.IVA', company.vatNumber ?? '—'], ['Codice fiscale', company.taxCode ?? '—'], ['REA', company.rea ?? '—'], ['PEC', company.pec ?? '—'], ['Sede legale', company.legalAddress ?? '—'], ['ATECO', [company.atecoCode, company.atecoDescription].filter(Boolean).join(' · ') || '—'], ['DURC', company.durcStatus ?? '—'], ['Note', company.notes ?? '—'],
    ]} /><TimestampMeta createdAt={company.createdAt} updatedAt={company.updatedAt} /></Card>
    <Card title="Titolari, soci e amministratori">{people.length === 0 ? <EmptyState title="Nessuna persona collegata" /> : <Table headers={['Persona','Ruolo','Quota']} rows={people.map((p) => [p.personId, p.role, p.ownershipPercent ? `${p.ownershipPercent}%` : '—'])} />}</Card>
  </div>;
}
