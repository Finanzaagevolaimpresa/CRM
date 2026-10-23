import assert from 'node:assert/strict';
import test from 'node:test';
import { technicalManagementPath, technicalTargetReference, technicalWorkPath } from '../src/lib/technical-assignment-display';

test('confirmed and recovered assignment links project the target from a recipient reference', () => {
  for (const kind of ['Project', 'TechnicalPractice'] as const) {
    const decision = { kind, targetId: 'record_a', recipientId: 'technician_a' };
    assert.equal(technicalManagementPath(decision), kind === 'Project'
      ? '/projects/record_a/assignments' : '/technical-office/practices/record_a/assignments');
    assert.equal(technicalWorkPath(decision), `/technical-work/${kind === 'Project' ? 'projects' : 'practices'}/record_a`);
    // Input boundaries still reject a recipient reference in place of a target.
    assert.equal(technicalTargetReference.safeParse(decision).success, false);
  }
});

test('navigation never accepts injected target path segments or an unsupported kind', () => {
  for (const targetId of ['../other', 'record?recipient=other', 'record/other', '%2Fother', '']) {
    const target = { kind: 'Project' as const, targetId };
    assert.throws(() => technicalManagementPath(target));
    assert.throws(() => technicalWorkPath(target));
  }
  const target = { kind: 'Client', targetId: 'record_a' } as unknown as Parameters<typeof technicalManagementPath>[0];
  assert.throws(() => technicalManagementPath(target));
  assert.throws(() => technicalWorkPath(target));
});
