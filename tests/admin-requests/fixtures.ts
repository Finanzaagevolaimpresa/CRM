import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { technicalFixture, technicalTarget, assignmentInput } from '../technical-assignments/fixtures';
import { leadProof, type Person } from '../selective-leads/fixtures';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '../../src/lib/technical-assignment-service';
import { readAdminRequestEntry, readAdminRequestDraftPrefill } from '../../src/lib/admin-request-service';
import type { RequestSubject } from '../../src/lib/admin-request-admission';
export async function requestFixture(db: PrismaClient, admin: Person, passwordHash?: string) {
  const f = await technicalFixture(db, admin, passwordHash);
  for (const person of [f.techA, f.techB]) {
    for (const kind of ['Project', 'TechnicalPractice'] as const) {
      const target = technicalTarget(f, kind), input = await assignmentInput(db, admin, target, person);
      // Backoffice may request help for an assigned project, but has no project.write.
      // Keep the fixture within the real role ceiling; do not grant that permission.
      if (kind === 'Project' && person.user.role === 'backoffice') {
        input.selection.actions = ['request_admin']; input.selection.editableFields = [];
      } else input.selection.actions.push('request_admin');
      const ref = { ...target, recipientId: person.user.id };
      const preview = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
      await confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', input, preview.token, true);
    }
  }
  return f;
}
export async function requestInput(db: PrismaClient, person: Person, subject: RequestSubject) {
  return { ...await readAdminRequestEntry(db, person.session, subject), commandId: randomUUID(),
    kind: 'DOCUMENT' as const, title: 'Documento tecnico richiesto', details: 'Servono informazioni tecniche pertinenti al record.' };
}
export function requestDraft(p: Awaited<ReturnType<typeof readAdminRequestDraftPrefill>>, mailboxAddress: string) {
  return { messageId: p.requestId, expectedRevision: 0, context: p.context, mailboxId: p.mailboxId, replyTo: mailboxAddress,
    to: ['synthetic-recipient@invalid.test'], cc: [], bcc: [], subject: 'Richiesta documenti verificata',
    body: 'Testo composto e verificato personalmente per la prova isolata.', attachmentVersionIds: [], contextFileIds: [], classification: 'ORDINARY',
    requestSource: { requestId: p.requestId, sourceHash: p.sourceHash } };
}
