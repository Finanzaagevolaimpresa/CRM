import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboardCounterGroups,
  type DashboardCounterAccess,
  type DashboardCounterCounts,
} from "../src/lib/dashboard-counter-groups";

const noAccess: DashboardCounterAccess = {
  canReadLeads: false,
  canReadTechnical: false,
  canReviewPracticeCommunications: false,
  canReadPracticeCommunications: false,
  canReadClients: false,
  canReadProjects: false,
  canReadServices: false,
  canReadPayments: false,
  canReadDossiers: false,
  canReadAiOutputs: false,
  isAdmin: false,
};

const counts: DashboardCounterCounts = {
  leadDaContattare: 11,
  trattativeAperte: 12,
  offerteInviate: 13,
  offerteAccettate: 14,
  activeTechnicalPracticesCount: 21,
  overdueClientUpdates: 22,
  commsToReview: 23,
  approvedUnusedComms: 24,
  clientiAttivi: 31,
  progettiAttivi: 32,
  serviziAcquistati: 33,
  tasks: 41,
  todayTasksCount: 42,
  overdueTasks: 43,
  dueSoonTasks: 44,
  payments: 51,
  preReview: 61,
  dossierBozza: 62,
  aiReview: 63,
  pendingAiAuthorizationRequestCount: 127,
};

test("no permissions exposes no group, even when every hidden count is nonzero", () => {
  assert.deepEqual(buildDashboardCounterGroups(noAccess, counts), []);
});

test("commercial-only access preserves four distinct lead and offer counters", () => {
  const result = buildDashboardCounterGroups({ ...noAccess, canReadLeads: true }, counts);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Commerciale");
  assert.deepEqual(result[0].counters.map(({ value, href }) => [value, href]), [
    [11, "/leads"], [12, "/leads"], [13, "/commercial-offers"], [14, "/commercial-offers"],
  ]);
});

test("technical read does not expose communication counts without their permissions", () => {
  const result = buildDashboardCounterGroups({ ...noAccess, canReadTechnical: true }, counts);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Ufficio Tecnico");
  assert.deepEqual(result[0].counters.map(({ value }) => value), [21, 22]);
});

test("communication review and read are independent, with no implied technical access", () => {
  const reviewOnly = buildDashboardCounterGroups({ ...noAccess, canReviewPracticeCommunications: true }, counts);
  const readOnly = buildDashboardCounterGroups({ ...noAccess, canReadPracticeCommunications: true }, counts);
  assert.deepEqual(reviewOnly.map(({ counters }) => counters.map(({ value }) => value)), [[23]]);
  assert.deepEqual(readOnly.map(({ counters }) => counters.map(({ value }) => value)), [[24]]);
});

test("client, project and service counters require their individual permission", () => {
  const clientOnly = buildDashboardCounterGroups({ ...noAccess, canReadClients: true }, counts);
  const projectOnly = buildDashboardCounterGroups({ ...noAccess, canReadProjects: true }, counts);
  const serviceOnly = buildDashboardCounterGroups({ ...noAccess, canReadServices: true }, counts);
  assert.deepEqual(clientOnly[0].counters.map(({ value, href }) => [value, href]), [[31, "/clients"]]);
  assert.deepEqual(projectOnly[0].counters.map(({ value, href }) => [value, href]), [[32, "/projects"]]);
  assert.deepEqual(serviceOnly.map(({ title }) => title), ["Clienti e servizi", "Attività e scadenze"]);
  assert.deepEqual(serviceOnly[0].counters.map(({ value, href }) => [value, href]), [[33, "/dashboard#pipeline-pratiche"]]);
  assert.equal(serviceOnly.flatMap(({ counters }) => counters).some(({ href }) => href === "/clients"), false);
});

test("ordinary AI review cannot expose admin authorization totals", () => {
  const result = buildDashboardCounterGroups({ ...noAccess, canReadAiOutputs: true }, counts);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].counters.map(({ value, href }) => [value, href]), [[63, "/ai/outputs-to-review"]]);
});

test("admin authorization total remains complete above the 20-row preview limit", () => {
  const result = buildDashboardCounterGroups({ ...noAccess, isAdmin: true }, counts);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].counters.map(({ value, href }) => [value, href]), [[127, "/settings/ai-authorizations"]]);
  assert.equal(result[0].counters.some(({ href }) => href === "/ai/outputs-to-review"), false);
});

test("visible zero is preserved while denied nonzero values are omitted", () => {
  const result = buildDashboardCounterGroups(
    { ...noAccess, canReadClients: true, canReadPayments: true },
    { ...counts, clientiAttivi: 0, payments: 0 },
  );
  assert.deepEqual(result.map(({ title, counters }) => [title, counters.map(({ value }) => value)]), [
    ["Clienti e servizi", [0]], ["Amministrazione", [0]],
  ]);
});

test("task totals and overlapping due-date counters are passed separately without summing", () => {
  const result = buildDashboardCounterGroups(
    { ...noAccess, canReadServices: true },
    { ...counts, tasks: 3, todayTasksCount: 2, overdueTasks: 2, dueSoonTasks: 1 },
  );
  const tasks = result.find(({ title }) => title === "Attività e scadenze");
  assert.ok(tasks);
  assert.deepEqual(tasks.counters.map(({ label, value }) => [label, value]), [
    ["Attività aperte", 3], ["In scadenza oggi", 2], ["Attività scadute", 2], ["Entro 7 giorni", 1],
  ]);
  assert.equal(Object.hasOwn(tasks, "total"), false);
});

test("dossier access exposes both revision counters without implying AI access", () => {
  const result = buildDashboardCounterGroups({ ...noAccess, canReadDossiers: true }, counts);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].counters.map(({ value, href }) => [value, href]), [[61, "/preanalyses"], [62, "/dossiers"]]);
});

test("payment card identifies the count as records, not euro", () => {
  const result = buildDashboardCounterGroups({ ...noAccess, canReadPayments: true }, counts);
  assert.equal(result[0].counters[0].value, 51);
  assert.match(result[0].counters[0].description, /registrazioni.*non importo in euro/);
  assert.equal(result[0].counters[0].href, "/payments");
});

test("full access yields six groups and preserves all 20 independent source values", () => {
  const allAccess = Object.fromEntries(Object.keys(noAccess).map((key) => [key, true])) as DashboardCounterAccess;
  const result = buildDashboardCounterGroups(allAccess, counts);
  assert.deepEqual(result.map(({ title }) => title), [
    "Commerciale", "Ufficio Tecnico", "Clienti e servizi", "Attività e scadenze", "Amministrazione", "Revisioni e autorizzazioni",
  ]);
  assert.deepEqual(result.flatMap(({ counters }) => counters.map(({ value }) => value)), Object.values(counts));
});

test("outputs do not mutate input data or contaminate a later request", () => {
  const access = Object.freeze({ ...noAccess, canReadPayments: true });
  const source = Object.freeze({ ...counts });
  const first = buildDashboardCounterGroups(access, source);
  first[0].counters[0].value = -1;
  first[0].counters[0].label = "changed";
  first[0].title = "changed";
  const second = buildDashboardCounterGroups(access, source);
  assert.equal(second[0].title, "Amministrazione");
  assert.equal(second[0].counters[0].value, 51);
  assert.equal(second[0].counters[0].label, "Pagamenti aperti");
  assert.equal(source.payments, 51);
});
