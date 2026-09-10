import assert from "node:assert/strict";
import test from "node:test";
import type { AiExecutionRequestStatus, Prisma } from "@prisma/client";
import {
  DASHBOARD_AI_AUTHORIZATION_PREVIEW_LIMIT,
  loadDashboardPendingAiAuthorizations,
} from "../src/lib/dashboard-ai-authorizations";

type SyntheticRequest = {
  id: string;
  status: AiExecutionRequestStatus;
  expiresAt: Date;
  createdAt: Date;
};

const now = new Date("2026-09-10T12:00:00.000Z");
const valid = Array.from({ length: 25 }, (_, index) => ({
  id: `synthetic-pending-${String(index + 1).padStart(2, "0")}`,
  status: "PENDING_ADMIN_APPROVAL" as const,
  expiresAt: new Date(now.getTime() + 60_000),
  createdAt: new Date(now.getTime() - (25 - index) * 1_000),
}));
const requests: SyntheticRequest[] = [
  ...valid,
  { id: "synthetic-expired-before", status: "PENDING_ADMIN_APPROVAL", expiresAt: new Date(now.getTime() - 1), createdAt: now },
  { id: "synthetic-expired-at-threshold", status: "PENDING_ADMIN_APPROVAL", expiresAt: now, createdAt: now },
  { id: "synthetic-approved", status: "APPROVED", expiresAt: new Date(now.getTime() + 60_000), createdAt: now },
];

function matches(where: Prisma.AiExecutionRequestWhereInput, request: SyntheticRequest) {
  return request.status === where.status && request.expiresAt > (where.expiresAt as { gt: Date }).gt;
}

function syntheticLoader(isAdmin: boolean) {
  let countCalls = 0;
  let previewCalls = 0;
  return {
    getCalls: () => ({ countCalls, previewCalls }),
    result: loadDashboardPendingAiAuthorizations({
      isAdmin,
      now,
      count: async (where) => {
        countCalls += 1;
        return requests.filter((request) => matches(where, request)).length;
      },
      preview: async ({ where, orderBy, take }) => {
        previewCalls += 1;
        assert.deepEqual(orderBy, { createdAt: "asc" });
        return requests
          .filter((request) => matches(where, request))
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          .slice(0, take);
      },
    }),
  };
}

test("il totale completo è distinto dall'anteprima ordinata e limitata", async () => {
  const loader = syntheticLoader(true);
  const result = await loader.result;

  assert.equal(result.total, 25);
  assert.equal(result.requests.length, DASHBOARD_AI_AUTHORIZATION_PREVIEW_LIMIT);
  assert.deepEqual(result.requests.map(({ id }) => id), valid.slice(0, 20).map(({ id }) => id));
  assert.deepEqual(loader.getCalls(), { countCalls: 1, previewCalls: 1 });
});

test("stato, scadenza e istante di soglia condivisi escludono richieste non pendenti", async () => {
  const result = await syntheticLoader(true).result;

  assert.equal(result.total, valid.length);
  assert.ok(result.requests.every((request) => request.status === "PENDING_ADMIN_APPROVAL"));
  assert.ok(result.requests.every((request) => request.expiresAt > now));
});

test("un ruolo non Admin non legge né conta la coda", async () => {
  const loader = syntheticLoader(false);
  const result = await loader.result;

  assert.deepEqual(result, { total: 0, requests: [] });
  assert.deepEqual(loader.getCalls(), { countCalls: 0, previewCalls: 0 });
});
