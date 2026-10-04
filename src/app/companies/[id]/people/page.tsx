import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { PageHeader, Card, EmptyState } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { RecordProfileForm } from '@/components/record-profile-form';
import { requirePermission } from '@/lib/auth';
import { getCompanyReadAccess } from '@/lib/read-access';
import { canEditClient } from '@/lib/access-control';
import { prisma } from '@/lib/prisma';
import { personProfileFields } from '@/lib/record-profile-fields';
import { personProfileVersion } from '@/lib/record-profile-contract';
import { recordProfileValues } from '@/lib/record-profile-view';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('company.write'), { id } = await params;
  const context = await getCompanyReadAccess(session, id);
  if (!context || !canEditClient(session, context.client)) notFound();
  const memberships = await prisma.companyPerson.findMany({ where: { companyId: id }, orderBy: { id: 'asc' } });
  const people = await prisma.person.findMany({ where: { id: { in: memberships.map(link => link.personId) }, deletedAt: null } });
  const byId = new Map(people.map(person => [person.id, person]));
  return <div className="crm-space-y-6"><PageHeader title="Gestisci referenti" description={`Titolari, soci, amministratori e persone di contatto di ${context.company.name}.`} />
    <SecondaryLink href={`/companies/${id}`}>Torna all’azienda</SecondaryLink>
    {memberships.length === 0 && <EmptyState title="Nessun referente inserito" />}
    {memberships.map(link => { const person = byId.get(link.personId); return person ? <Card key={link.id} title={`${person.firstName} ${person.lastName}`}>
      <RecordProfileForm fields={personProfileFields} values={recordProfileValues({ ...person, ...link }, personProfileFields)}
        hidden={{ kind: 'person', id: link.id, companyId: id, expectedVersion: personProfileVersion(person, link) }} submitLabel="Salva referente" /></Card> : null; })}
    <Card title="Aggiungi referente"><RecordProfileForm fields={personProfileFields} values={{}}
      hidden={{ kind: 'new-person', id: randomUUID(), companyId: id }} submitLabel="Aggiungi referente" /></Card></div>;
}
