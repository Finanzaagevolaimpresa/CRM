import type { ProjectExpense } from '@prisma/client';
import { canonicalSha256 } from './canonical-json';
import { RecordUpdateError } from './record-update-contract';
import type { ProjectParameters } from './project-parameters-input';

/** Include non-editable fields: a simultaneous eligibility assessment must also
 * invalidate the preview. Values remain in the Admin form, never in the audit. */
export function projectExpenseVersion(rows: readonly ProjectExpense[]) {
  return canonicalSha256([...rows].sort((a, b) => a.id.localeCompare(b.id)).map(row => ({
    ...row, amount: row.amount.toString(),
  })));
}
export function assertProjectParametersCurrent(proposed: ProjectParameters, current: ProjectParameters) {
  const retained = proposed.expenses.flatMap(row => row.id ? [row.id] : []).sort();
  const expected = current.expenses.flatMap(row => row.id ? [row.id] : []).sort();
  if (proposed.expenseVersion !== current.expenseVersion || JSON.stringify(retained) !== JSON.stringify(expected))
    throw new RecordUpdateError('STALE');
}
