import type { Prisma } from '@prisma/client';
import type { SharedOperationalContext } from './shared-operational-context';

/** Called only after current scoped admission. A closed SELECT list is deliberate:
 * no notes, ownership shares, income, contract, payment or document metadata. */
export async function sharedOperationalContacts(tx: Prisma.TransactionClient, context: SharedOperationalContext) {
  const companies = await tx.company.findMany({ where: { clientId: context.client.id, deletedAt: null,
    ...(context.companyId ? { id: context.companyId } : {}) }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: {
    id: true, name: true, taxCode: true, vatNumber: true, pec: true, sdiCode: true,
    legalAddress: true, operatingAddress: true,
    legalStreet: true, legalStreetNumber: true, legalPostalCode: true, legalCity: true, legalProvince: true,
    operatingStreet: true, operatingStreetNumber: true, operatingPostalCode: true, operatingCity: true, operatingProvince: true,
  } });
  const links = await tx.companyPerson.findMany({ where: { companyId: { in: companies.map(row => row.id) },
    OR: [{ isAdministrator: true }, { isOperationalContact: true }] },
    orderBy: { id: 'asc' }, select: { id: true, companyId: true, personId: true, role: true,
      isAdministrator: true, isOperationalContact: true } });
  const people = await tx.person.findMany({ where: { id: { in: links.map(row => row.personId) }, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, taxCode: true, email: true, phone: true } });
  const lead = context.client.leadId ? await tx.lead.findFirst({ where: { id: context.client.leadId,
    clientId: context.client.id, deletedAt: null }, select: {
    id: true, firstName: true, lastName: true, companyName: true, contactPerson: true, phone: true, email: true,
  } }) : null;
  return { clientName: context.client.displayName,
    companyScope: context.companyId ? 'Azienda collegata al progetto' : 'Aziende collegate al cliente; nessuna selezione implicita',
    companies: companies.map(company => ({ ...company, origin: 'Anagrafica azienda e collegamenti persona canonici',
      people: links.filter(link => link.companyId === company.id).flatMap(link => {
        const person = people.find(row => row.id === link.personId);
        return person ? [{ id: link.id, role: link.role, isAdministrator: link.isAdministrator,
          isOperationalContact: link.isOperationalContact, person, origin: 'Referente collegato a questa azienda' }] : [];
      }) })),
    // Lead facts are a separate source, not an inferred administrator/contact.
    lead: lead ? { ...lead, origin: 'Lead di origine del cliente; ruolo aziendale da verificare' } : null };
}
