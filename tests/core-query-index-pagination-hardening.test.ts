import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { RoleCode } from '@prisma/client';
import { canViewClient, canViewLead } from '../src/lib/access-control';
import {
  CORE_QUERY_MAX_CANDIDATES,
  CORE_QUERY_PAGE_SIZE,
  clientVisibilityWhere,
  coreQueryCandidateLimit,
  coreQueryFetchSize,
  coreQueryOffset,
  coreQueryPageHref,
  leadVisibilityWhere,
  normalizeCoreQueryLimit,
  parseCoreQueryPage,
  toCoreQueryPage,
} from '../src/lib/core-query-policy';

const migrationPath = 'prisma/migrations/20260818120000_core_query_index_pagination_hardening_v1/migration.sql';
const migration = readFileSync(migrationPath, 'utf8');
const leadsPage = readFileSync('src/app/leads/page.tsx', 'utf8');
const clientsPage = readFileSync('src/app/clients/page.tsx', 'utf8');
const readAccess = readFileSync('src/lib/read-access.ts', 'utf8');

function actor(role: RoleCode, userId = 'actor-1') {
  return { role, userId };
}

function matchesClientWhere(
  where: ReturnType<typeof clientVisibilityWhere>,
  client: { id: string; salesOwnerId: string | null; consultantId: string | null; selectiveRecipients?: string[] },
): boolean {
  if (where.AND && !(Array.isArray(where.AND) ? where.AND : [where.AND]).every(item => matchesClientWhere(item, client))) return false;
  if (where.OR && !where.OR.some(item => matchesClientWhere(item, client))) return false;
  if (typeof where.id === 'string' && where.id !== client.id) return false;
  if (typeof where.id === 'object' && where.id !== null) {
    const filter = where.id as { in?: string[]; notIn?: string[] };
    if (filter.in && !filter.in.includes(client.id)) return false;
    if (filter.notIn?.includes(client.id)) return false;
  }
  const excludedRecipient = where.selectiveGrants?.none?.recipientId;
  if (typeof excludedRecipient === 'string' && client.selectiveRecipients?.includes(excludedRecipient)) return false;
  if (where.salesOwnerId !== undefined && client.salesOwnerId !== where.salesOwnerId) return false;
  if (where.consultantId !== undefined && client.consultantId !== where.consultantId) return false;
  return true;
}

function matchesLeadWhere(
  where: ReturnType<typeof leadVisibilityWhere>,
  lead: { assignedToId: string | null },
): boolean {
  if (where.assignedToId === undefined) return true;
  if (typeof where.assignedToId === 'object' && where.assignedToId !== null) return lead.assignedToId !== null;
  return where.assignedToId === lead.assignedToId;
}

test('N07 pagination is canonical, bounded and over-fetches exactly one row', () => {
  assert.equal(CORE_QUERY_PAGE_SIZE, 50);
  assert.equal(coreQueryFetchSize(), 51);
  assert.equal(parseCoreQueryPage('1'), 1);
  assert.equal(parseCoreQueryPage('200'), 200);
  for (const value of [undefined, '', '0', '-1', '01', '1.5', '201', '9999', {}, []]) {
    assert.equal(parseCoreQueryPage(value), 1);
  }
  assert.equal(coreQueryOffset(1), 0);
  assert.equal(coreQueryOffset(3), 100);
  assert.equal(coreQueryOffset(Number.MAX_SAFE_INTEGER), 0);
  const page = toCoreQueryPage(Array.from({ length: 51 }, (_, index) => index), 2);
  assert.deepEqual(page.items, Array.from({ length: 50 }, (_, index) => index));
  assert.equal(page.hasPrevious, true);
  assert.equal(page.hasNext, true);
  assert.equal(Object.isFrozen(page), true);
});

test('N07 list limits fail closed and never permit an unbounded candidate query', () => {
  assert.equal(normalizeCoreQueryLimit(undefined), 50);
  assert.equal(normalizeCoreQueryLimit(1), 1);
  assert.equal(normalizeCoreQueryLimit(10_000), 100);
  assert.equal(normalizeCoreQueryLimit(0), 50);
  assert.equal(normalizeCoreQueryLimit(Number.NaN), 50);
  assert.equal(coreQueryCandidateLimit(1), 5);
  assert.equal(coreQueryCandidateLimit(100), CORE_QUERY_MAX_CANDIDATES);
  assert.equal(coreQueryCandidateLimit(10_000), CORE_QUERY_MAX_CANDIDATES);
});

test('N07 database visibility predicates preserve the existing ABAC decisions', () => {
  const clients = [
    { id: 'none', salesOwnerId: null, consultantId: null },
    { id: 'sales', salesOwnerId: 'actor-1', consultantId: null },
    { id: 'consultant', salesOwnerId: null, consultantId: 'actor-1' },
    { id: 'other', salesOwnerId: 'other', consultantId: 'other' },
  ];
  const leads = [{ assignedToId: null }, { assignedToId: 'actor-1' }, { assignedToId: 'other' }];
  const roles: RoleCode[] = ['admin', 'direzione', 'commerciale', 'consulente', 'revisore', 'backoffice', 'amministrazione', 'collaboratore_limitato'];
  for (const role of roles) {
    for (const clientReadScope of [[], ['none', 'other']]) {
    const session = { ...actor(role), clientReadScope };
    for (const client of clients) {
      assert.equal(matchesClientWhere(clientVisibilityWhere(session), client), canViewClient(session, client), `${role}:${client.id}`);
    }
    for (const lead of leads) {
      assert.equal(matchesLeadWhere(leadVisibilityWhere(session), lead), canViewLead(session, lead), `${role}:${String(lead.assignedToId)}`);
    }
    }
  }
});

test('N07 links retain allowlisted filters while canonicalizing the page parameter', () => {
  assert.equal(coreQueryPageHref('/leads', { page: '9', status: 'nuovo', empty: undefined }, 1), '/leads?status=nuovo');
  assert.equal(coreQueryPageHref('/leads', { status: 'nuovo', fonte: 'sito' }, 3), '/leads?fonte=sito&status=nuovo&page=3');
});

test('client list ceiling overrides ownership and full-read scope, including a selection added after session load', () => {
  const selected = { id: 'selected', salesOwnerId: 'actor-1', consultantId: 'actor-1', selectiveRecipients: ['actor-1'] };
  const ordinary = { ...selected, id: 'ordinary', selectiveRecipients: [] };
  for (const role of ['admin', 'direzione', 'commerciale', 'consulente', 'revisore', 'backoffice', 'amministrazione', 'collaboratore_limitato'] as const) {
    const session = { ...actor(role), clientReadScope: ['selected', 'ordinary'], selectiveClientIds: ['selected'] };
    assert.equal(matchesClientWhere(clientVisibilityWhere(session), selected), false, role);
    assert.equal(canViewClient(session, selected), false, role);
    assert.equal(matchesClientWhere(clientVisibilityWhere(session), ordinary), true, role);
    // The relation predicate rejects a historical grant even when the in-memory
    // snapshot predates it. No active/expiry filter can reopen the ordinary row.
    assert.equal(matchesClientWhere(clientVisibilityWhere({ ...session, selectiveClientIds: [] }), selected), false, `${role}:stale`);
    assert.equal(matchesClientWhere(clientVisibilityWhere({ ...session, selectiveClientIds: [] }), { ...selected, selectiveRecipients: ['another-recipient'] }), true, `${role}:other recipient`);
  }
});

test('N07 core pages push visibility and limits into Prisma before rendering', () => {
  for (const [name, source] of [['leads', leadsPage], ['clients', clientsPage]] as const) {
    assert.match(source, /parseCoreQueryPage/);
    assert.match(source, /coreQueryOffset/);
    assert.match(source, /coreQueryFetchSize/);
    assert.match(source, /PaginationNav/);
    assert.doesNotMatch(source, /\.filter\(\((?:x|client)\) => canView/);
    assert.match(source, /orderBy:[\s\S]*\{ id: ['"]desc['"] \}/, name);
  }
  assert.match(leadsPage, /leadVisibilityWhere\(session\)/);
  assert.match(clientsPage, /clientVisibilityWhere\(session\)/);
  assert.match(clientsPage, /clientId: \{ in: clientIds \}/);
  assert.match(clientsPage, /distinct: \['clientId'\]/);
});

test('N07 access helpers apply candidate limits at the database boundary and safe defaults afterwards', () => {
  assert.match(readAccess, /aiOutput\.findMany\(\{[\s\S]*take: candidateLimit/);
  assert.match(readAccess, /aiRun\.findMany\(\{[\s\S]*take: candidateLimit/);
  assert.match(readAccess, /task\.findMany\(\{ \.\.\.candidateArgs, where: \{ AND: \[candidateArgs\.where \?\? \{\}, \{ technicalPrivate: false \}\] \}, take: candidateLimit \}\)/);
  assert.match(readAccess, /slice\(0, limit\)/);
  assert.doesNotMatch(readAccess, /slice\(0, take\)/);
});

test('N07 migration 36 is additive, transactional and index-only', () => {
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).sort();
  assert.equal(names.length, 69);
  assert.equal(names[35], '20260818120000_core_query_index_pagination_hardening_v1');
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.equal((migration.match(/CREATE INDEX/g) ?? []).length, 11);
  for (const index of [
    'Lead_pipeline_cursor_idx', 'Lead_assignee_pipeline_cursor_idx',
    'Client_active_cursor_idx', 'Client_sales_owner_cursor_idx', 'Client_consultant_cursor_idx',
    'ClientService_client_status_cursor_idx', 'Document_client_active_idx',
    'Task_active_due_cursor_idx', 'Task_assignee_due_cursor_idx',
    'AiRun_created_cursor_idx', 'AiOutput_created_cursor_idx',
  ]) assert.match(migration, new RegExp(`CREATE INDEX "${index}"`));
  assert.doesNotMatch(migration, /^\s*(?:DROP|ALTER TABLE|TRUNCATE|DELETE|UPDATE|INSERT)\b/im);
});
