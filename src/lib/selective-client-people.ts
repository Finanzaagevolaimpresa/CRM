import { Prisma } from '@prisma/client';
import type { AuthSession } from './auth';
import { mayReadCompanyInformation } from './selective-client-companies';
import { parseClientCompanyChoices, type ClientCompanyChoice } from './selective-client-company-policy';
import { parseClientPersonChoices, projectSelectedClientPeople, type ClientPersonChoice, type ClientPersonOption } from './selective-client-person-policy';
import { snapshotSelectedClientPeople } from './selective-client-person-snapshot';

type Tx = Prisma.TransactionClient;
type Actor = Pick<AuthSession, 'active' | 'role' | 'permissionOverrides'>;
function denied(): never { throw new Error('SELECTIVE_PERSON_UNAVAILABLE'); }

/** After ordered actor/session/client locks, acquire the complete company set
 * before relationships, persons and ledgers. Existing profile writers use
 * Client -> Company -> CompanyPerson -> Person. Company choices are included
 * here so the later company projection cannot acquire a new parent out of order. */
export async function selectClientPeople(tx: Tx, authority: Actor, recipient: Actor, clientId: string,
  input: readonly ClientPersonChoice[], companyInput: readonly ClientCompanyChoice[]) {
  const choices = parseClientPersonChoices(input);
  if (!choices.length) return { snapshots: [], projection: [] };
  if (!mayReadCompanyInformation(authority) || !mayReadCompanyInformation(recipient)) denied();
  const companyIds = [...new Set([...choices.map(row => row.companyId), ...parseClientCompanyChoices(companyInput).map(row => row.companyId)])].sort();
  const membershipIds = choices.map(row => row.membershipId).sort();
  const personIds = [...new Set(choices.map(row => row.personId))].sort();
  for (const id of companyIds) await tx.$queryRaw`SELECT id FROM "Company" WHERE id=${id} FOR SHARE`;
  for (const id of companyIds) await tx.$queryRaw`SELECT "companyId" FROM "SelectiveCompanyGeneration" WHERE "companyId"=${id} FOR SHARE`;
  for (const id of membershipIds) await tx.$queryRaw`SELECT id FROM "CompanyPerson" WHERE id=${id} FOR SHARE`;
  const memberships = await tx.companyPerson.findMany({ where: { id: { in: membershipIds } } });
  if (memberships.length !== choices.length || choices.some(choice => !memberships.some(row => row.id === choice.membershipId
    && row.companyId === choice.companyId && row.personId === choice.personId))) denied();
  for (const id of personIds) await tx.$queryRaw`SELECT id FROM "Person" WHERE id=${id} FOR SHARE`;
  for (const id of personIds) await tx.$queryRaw`SELECT "personId" FROM "SelectivePersonGeneration" WHERE "personId"=${id} FOR SHARE`;
  for (const id of membershipIds) await tx.$queryRaw`SELECT "membershipId" FROM "SelectiveMembershipGeneration" WHERE "membershipId"=${id} FOR SHARE`;
  const companies = await tx.company.findMany({ where: { id: { in: companyIds }, clientId, deletedAt: null }, select: { id: true, clientId: true, deletedAt: true } });
  const people = await tx.person.findMany({ where: { id: { in: personIds }, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true, taxCode: true, deletedAt: true } });
  const companyGenerations = await tx.$queryRaw<Array<{ companyId: string; generation: number }>>(Prisma.sql`
    SELECT "companyId", generation FROM "SelectiveCompanyGeneration" WHERE "companyId" IN (${Prisma.join(companyIds)})`);
  const personGenerations = await tx.$queryRaw<Array<{ personId: string; generation: number }>>(Prisma.sql`
    SELECT "personId", generation FROM "SelectivePersonGeneration" WHERE "personId" IN (${Prisma.join(personIds)})`);
  const membershipGenerations = await tx.$queryRaw<Array<{ membershipId: string; generation: number }>>(Prisma.sql`
    SELECT "membershipId", generation FROM "SelectiveMembershipGeneration" WHERE "membershipId" IN (${Prisma.join(membershipIds)})`);
  const current = memberships.map(link => {
    const company = companies.find(row => row.id === link.companyId), person = people.find(row => row.id === link.personId);
    if (!company || !person) return denied();
    return { membershipId: link.id, companyId: link.companyId, personId: link.personId, clientId: company.clientId,
      companyDeletedAt: company.deletedAt, personDeletedAt: person.deletedAt,
      firstName: person.firstName, lastName: person.lastName, email: person.email, phone: person.phone, taxCode: person.taxCode,
      role: link.role, ownershipPercent: link.ownershipPercent?.toFixed() ?? null,
      companyEpoch: companyGenerations.find(row => row.companyId === link.companyId)?.generation,
      personEpoch: personGenerations.find(row => row.personId === link.personId)?.generation,
      membershipEpoch: membershipGenerations.find(row => row.membershipId === link.id)?.generation };
  });
  return { snapshots: snapshotSelectedClientPeople(clientId, current, choices),
    projection: projectSelectedClientPeople(clientId, current, choices) };
}

/** Manager-only bounded catalogue; names help identify the intended record but
 * do not become recipient-visible fields or create any generation/grant. */
export async function listClientPeopleOptions(tx: Tx, authority: Actor, clientId: string) {
  if (!mayReadCompanyInformation(authority)) return { personOptions: [] as ClientPersonOption[], peopleLimited: false };
  const rows = await tx.$queryRaw<ClientPersonOption[]>`
    SELECT link.id AS "membershipId", link."companyId", link."personId",
      person."firstName" || ' ' || person."lastName" AS "personName", company.name AS "companyName"
    FROM "CompanyPerson" link JOIN "Company" company ON company.id=link."companyId"
    JOIN "Person" person ON person.id=link."personId"
    WHERE company."clientId"=${clientId} AND company."deletedAt" IS NULL AND person."deletedAt" IS NULL
    ORDER BY person."lastName", person."firstName", link.id LIMIT 101`;
  return { personOptions: rows.slice(0, 100), peopleLimited: rows.length > 100 };
}
