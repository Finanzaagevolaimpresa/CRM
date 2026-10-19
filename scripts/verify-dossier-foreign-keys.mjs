import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('prisma/migrations/20260920090000_engagement_dossier_approval_delivery_v1/migration.sql', 'utf8');
const diff = readFileSync(process.argv[2], 'utf8');
const expected = [...migration.matchAll(/ADD CONSTRAINT "([^"]+)" FOREIGN KEY/g)].map((match) => match[1]);
assert.equal(expected.length, 17, 'All migration47 foreign keys must be covered');
const dropped = new Set([...diff.matchAll(/DROP CONSTRAINT "([^"]+)"/g)].map((match) => match[1]));
assert.deepEqual(expected.filter((name) => dropped.has(name)), [], 'Prisma datamodel would remove dossier foreign keys');
const perimeter = readFileSync('prisma/migrations/20260924100000_admin_client_read_perimeters_v1/migration.sql', 'utf8');
const grants = [...perimeter.matchAll(/CONSTRAINT "([^"]+)" FOREIGN KEY/g)].map(match => match[1]);
assert.equal(grants.length, 4, 'All migration48 foreign keys must be covered');
assert.deepEqual(grants.filter(name => dropped.has(name)), [], 'Prisma datamodel would remove perimeter foreign keys');
const communications = readFileSync('prisma/migrations/20260927010000_approved_manual_communications_v1/migration.sql', 'utf8');
const messageKeys = [...communications.matchAll(/ADD CONSTRAINT "([^"]+)" FOREIGN KEY/g)].map(match => match[1]);
assert.equal(messageKeys.length, 18, 'All migration49 foreign keys must be covered');
assert.deepEqual(messageKeys.filter(name => dropped.has(name)), [], 'Prisma datamodel would remove communication foreign keys');
const selective = readFileSync('prisma/migrations/20261015090000_selective_project_access_v1/migration.sql', 'utf8');
const selectiveKeys = [...selective.matchAll(/CONSTRAINT "([^"]+)" FOREIGN KEY/g)].map(match => match[1]);
assert.equal(selectiveKeys.length, 4, 'All selective-perimeter foreign keys must be covered');
assert.deepEqual(selectiveKeys.filter(name => dropped.has(name)), [], 'Prisma datamodel would remove selective-perimeter foreign keys');
const ordinary = readFileSync('prisma/migrations/20261017120000_ordinary_email_v1/migration.sql', 'utf8');
const ordinaryKeys = [...ordinary.matchAll(/CREATE TABLE "([^"]+)" \(([\s\S]*?)\n\);/g)]
  .flatMap(([,table,columns]) => [...columns.matchAll(/"([^"]+)"[^\n]* REFERENCES /g)].map(([,column]) => table+'_'+column+'_fkey'));
assert.equal(ordinaryKeys.length, 21, 'All ordinary email foreign keys must be covered');
assert.deepEqual(ordinaryKeys.filter(name => dropped.has(name)), [], 'Prisma datamodel would remove ordinary email foreign keys');
assert.doesNotMatch(diff, /DROP TABLE "OrdinaryEmail|ALTER TABLE "OrdinaryEmail[^"]*"[^;]*DROP COLUMN/);
const contexts = readFileSync('prisma/migrations/20261017160000_admin_email_contexts_v1/migration.sql', 'utf8');
const contextKeys = [...contexts.matchAll(/CREATE TABLE "([^"]+)" \(([\s\S]*?)\n\);/g)]
  .flatMap(([,table,columns]) => [...columns.matchAll(/"([^"]+)"[^\n]* REFERENCES /g)].map(([,column]) => table+'_'+column+'_fkey'));
contextKeys.push('ApprovedCommunication_leadId_fkey', 'ApprovedCommunication_internalThreadId_fkey');
assert.equal(contextKeys.length, 11, 'Every new context foreign key must be covered');
assert.deepEqual(contextKeys.filter(name => dropped.has(name)), [], 'Prisma datamodel would remove context foreign keys');
assert.doesNotMatch(diff, /DROP TABLE "(?:InternalCommunication|CommunicationContextFile)|ALTER TABLE "(?:InternalCommunication[^"]*|CommunicationContextFile)"[^;]*DROP COLUMN/);
const leads = readFileSync('prisma/migrations/20261018140000_selective_lead_read_v1/migration.sql', 'utf8');
const leadKeys = [...leads.matchAll(/CREATE TABLE "([^"]+)" \(([\s\S]*?)\n\);/g)]
  .flatMap(([,table,columns]) => [...columns.matchAll(/"([^"]+)"[^\n]* REFERENCES /g)].map(([,column]) => table+'_'+column+'_fkey'));
assert.equal(leadKeys.length, 8, 'Every selective lead foreign key must be covered');
assert.deepEqual(leadKeys.filter(name => dropped.has(name)), [], 'Prisma datamodel would remove selective lead foreign keys');
assert.doesNotMatch(diff, /DROP TABLE "SelectiveLead|ALTER TABLE "SelectiveLead[^"]*"[^;]*DROP COLUMN/);
const clients = readFileSync('prisma/migrations/20261018190000_selective_client_read_v1/migration.sql', 'utf8');
const clientKeys = [...clients.matchAll(/CREATE TABLE "([^"]+)" \(([\s\S]*?)\n\);/g)]
  .flatMap(([,table,columns]) => [...columns.matchAll(/"([^"]+)"[^\n]* REFERENCES /g)].map(([,column]) => table+'_'+column+'_fkey'));
assert.equal(clientKeys.length, 8, 'Every selective client foreign key must be covered');
assert.deepEqual(clientKeys.filter(name => dropped.has(name)), [], 'Prisma datamodel would remove selective client foreign keys');
assert.doesNotMatch(diff, /DROP TABLE "SelectiveClient|ALTER TABLE "SelectiveClient[^"]*"[^;]*DROP COLUMN/);
const practices = readFileSync('prisma/migrations/20261018220000_selective_practice_read_v1/migration.sql', 'utf8');
const practiceKeys = [...practices.matchAll(/CREATE TABLE "([^"]+)" \(([\s\S]*?)\n\);/g)]
  .flatMap(([,table,columns]) => [...columns.matchAll(/"([^"]+)"[^\n]* REFERENCES /g)].map(([,column]) => table+'_'+column+'_fkey'));
assert.equal(practiceKeys.length, 8, 'Every selective practice foreign key must be covered');
assert.deepEqual(practiceKeys.filter(name => dropped.has(name)), [], 'Prisma datamodel would remove selective practice foreign keys');
assert.doesNotMatch(diff, /DROP TABLE "SelectivePractice|ALTER TABLE "SelectivePractice[^"]*"[^;]*DROP COLUMN/);
console.log(JSON.stringify({ dossierForeignKeySchemaParity: 'PASS', constraints: expected.length, clientReadGrantConstraints: grants.length,
  communicationConstraints: messageKeys.length, ordinaryEmailConstraints: ordinaryKeys.length, selectiveLeadConstraints: leadKeys.length,
  selectiveClientConstraints: clientKeys.length, selectivePracticeConstraints: practiceKeys.length }));
