import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import {
  authenticated1265LinkSchema,
  controlledDuplicateDecisionSchema,
  controlledIntakeSchema,
  createControlledIntake,
  decideControlledIntakeDuplicate,
  linkAuthenticated1265Projection,
} from '../src/lib/controlled-intake';

const input = {
  channel: 'EMAIL', sourceId: 'MSG-1', sourceOccurredAt: '2026-09-14T10:00:00.000Z',
  subjectType: 'PERSONA', firstName: 'Ada', lastName: 'Sintetica',
  effectiveCategory: 'da_classificare', need: 'Esigenza inventata', indicativeBudget: null,
};

test('four channels, nullable form fields and column limits are validated', () => {
  for (const channel of ['WPFORMS_1265', 'WPFORMS_1098', 'WPFORMS_1485', 'EMAIL']) {
    const result = controlledIntakeSchema.safeParse({
      ...input, channel, subjectName: null, phone: null, objective: null, functions: null,
      timing: null, declaredMaterials: null, engagementReference: null, administrativeRequest: channel === 'WPFORMS_1485' ? 'Da riconciliare' : null,
      ...(channel === 'WPFORMS_1098' ? { serviceCode: 'progetti_digitali', digitalProjectType: 'software_crm_workflow', objective: 'Obiettivo', functions: 'Funzioni' } : {}),
    });
    assert.equal(result.success, true);
  }
  assert.equal(controlledIntakeSchema.safeParse({ ...input, phone: 'x'.repeat(81) }).success, false);
  assert.equal(controlledIntakeSchema.safeParse({ ...input, subjectName: 'x'.repeat(201) }).success, false);
  assert.equal(controlledIntakeSchema.safeParse({ ...input, commercialOfferId: 'offer-on-email' }).success, false);
  assert.throws(() => controlledDuplicateDecisionSchema.parse({ intakeId: 'bad', candidateLeadId: '', outcome: 'MERGE', expectedVersion: 0 }), ZodError);
  assert.throws(() => authenticated1265LinkSchema.parse({ projectionLedgerId: 'bad', effectiveCategory: '', need: '', subjectType: 'OTHER' }), ZodError);
});

test('all three writers are disabled before validation, guard or transaction', { concurrency: false }, async () => {
  const previous = process.env.CONTROLLED_INTAKE_MODE;
  let transactions = 0;
  const db = { $transaction: async () => { transactions += 1; } } as never;
  try {
    delete process.env.CONTROLLED_INTAKE_MODE;
    await assert.rejects(createControlledIntake(db, {} as never, input), /DISABLED/u);
    await assert.rejects(decideControlledIntakeDuplicate(db, {} as never, {}), /DISABLED/u);
    await assert.rejects(linkAuthenticated1265Projection(db, {} as never, {}), /DISABLED/u);
    assert.equal(transactions, 0);
  } finally {
    if (previous === undefined) delete process.env.CONTROLLED_INTAKE_MODE;
    else process.env.CONTROLLED_INTAKE_MODE = previous;
  }
});

test('an incompatible database is rejected before a transaction', { concurrency: false }, async () => {
  const previous = { mode: process.env.CONTROLLED_INTAKE_MODE, url: process.env.DATABASE_URL };
  let transactions = 0;
  try {
    process.env.CONTROLLED_INTAKE_MODE = 'synthetic';
    process.env.DATABASE_URL = 'postgresql://example.invalid/production';
    await assert.rejects(createControlledIntake({ $transaction: async () => { transactions += 1; } } as never, {} as never, input), /SYNTHETIC_CONFIGURATION_DENIED/u);
    assert.equal(transactions, 0);
  } finally {
    if (previous.mode === undefined) delete process.env.CONTROLLED_INTAKE_MODE; else process.env.CONTROLLED_INTAKE_MODE = previous.mode;
    if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url;
  }
});
