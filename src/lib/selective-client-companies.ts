import { Prisma } from '@prisma/client';
import type { AuthSession } from './auth';
import { hasPermission } from './permission-evaluator';
import { parseClientCompanyChoices, projectSelectedClientCompanies, type ClientCompanyChoice } from './selective-client-company-policy';
import { snapshotSelectedClientCompanies } from './selective-client-company-snapshot';

type Tx = Prisma.TransactionClient;
type Person = Pick<AuthSession, 'active' | 'role' | 'permissionOverrides'>;
export function mayReadCompanyInformation(person: Person) {
  return person.active && hasPermission(person, 'company.read')
    && !person.permissionOverrides.some(row => row.permission === 'company.read' && !row.allowed);
}
function denied(): never { throw new Error('SELECTIVE_COMPANY_UNAVAILABLE'); }

/** Call after ordered users/session/client locks. Company rows are locked before
 * their separate ledger and before document resources. The ledger is not a
 * Company field: adding it must not change historical V2 document hashes. */
export async function selectClientCompanies(tx: Tx, authority: Person, recipient: Person,
  clientId: string, input: readonly ClientCompanyChoice[]) {
  const choices = parseClientCompanyChoices(input);
  if (!choices.length) return { snapshots: [], projection: [] };
  if (!mayReadCompanyInformation(authority) || !mayReadCompanyInformation(recipient)) denied();
  const ids = choices.map(row => row.companyId).sort();
  for (const id of ids) await tx.$queryRaw`SELECT id FROM "Company" WHERE id=${id} FOR SHARE`;
  for (const id of ids) await tx.$queryRaw`SELECT "companyId" FROM "SelectiveCompanyGeneration" WHERE "companyId"=${id} FOR SHARE`;
  const records = await tx.company.findMany({ where: { id: { in: ids }, clientId, deletedAt: null } });
  const generations = await tx.$queryRaw<Array<{ companyId: string; generation: number }>>(Prisma.sql`
    SELECT "companyId", generation FROM "SelectiveCompanyGeneration" WHERE "companyId" IN (${Prisma.join(ids)})`);
  const current = records.map(row => ({ ...row, companyEpoch: generations.find(g => g.companyId === row.id)?.generation }));
  return { snapshots: snapshotSelectedClientCompanies(clientId, current, choices),
    projection: projectSelectedClientCompanies(clientId, current, choices) };
}

/** A management GET lists existing companies but never provisions generations,
 * grants, permissions or a personal binding. Values appear only in the explicit
 * recipient preview, except the name needed by the authorized manager to choose. */
export async function listClientCompanyOptions(tx: Tx, authority: Person, clientId: string) {
  if (!mayReadCompanyInformation(authority)) return { companyOptions: [], companiesLimited: false };
  const rows = await tx.company.findMany({ where: { clientId, deletedAt: null },
    select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 101 });
  return { companyOptions: rows.slice(0, 100), companiesLimited: rows.length > 100 };
}
