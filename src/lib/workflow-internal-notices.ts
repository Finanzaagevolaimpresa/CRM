import { z } from 'zod';
import type { AuthSession } from './auth';
import { prisma } from './prisma';
import { updateActor } from './record-updates';
import { recordUpdateContext } from './record-update-context';
import { RecordUpdateError } from './record-update-contract';

/** Source projection only: the shared notification inbox applies the same
 * per-recipient read filter to this list and its counter. No GET marks a read. */
export async function readWorkflowInternalNotices(session: AuthSession, limit = 100, includeResolved = false) {
  void includeResolved;
  return prisma.$transaction(async tx => {
    const auth = await updateActor(tx, session, undefined, { readOnly: true });
    const [tables] = await tx.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass(format('%I.%I',current_schema(),'WorkflowExecution')) IS NOT NULL AS present`;
    if (!tables.present) { await auth.finish(); return []; }
    const rows = await tx.workflowExecution.findMany({ where: { recipientUserId: auth.actor.id, state: 'SENT',
      receipt: { path: ['channel'], equals: 'CRM_INTERNAL_NOTICE' } }, include: { enrollment: { include: { lead: true } } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] });
    const notices: Array<{ id: string; title: string; category: string; priority: 'media'; date: Date; related: null; href: string }> = [];
    for (const row of rows) {
      if (row.enrollment.lead.assignedToId !== auth.actor.id || row.enrollment.lead.deletedAt) continue;
      const receipt = z.object({ channel: z.literal('CRM_INTERNAL_NOTICE'), recipientUserId: z.string(), title: z.string().max(240), at: z.string().datetime({ offset: true }) }).passthrough().safeParse(row.receipt);
      if (!receipt.success || receipt.data.recipientUserId !== auth.actor.id) continue;
      try { if (!(await recordUpdateContext(tx, 'LEAD', row.enrollment.leadId)).canRead(auth.actor)) continue; }
      catch (error) { if (error instanceof RecordUpdateError) continue; throw error; }
      notices.push({ id: 'workflow-' + row.id, title: receipt.data.title, category: 'Automazione interna', priority: 'media',
        date: new Date(receipt.data.at), related: null, href: '/leads/' + row.enrollment.leadId });
      if (notices.length >= limit) break;
    }
    await auth.finish(); return notices;
  }, { timeout: 30_000 });
}
