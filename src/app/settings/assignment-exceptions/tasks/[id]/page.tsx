import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@/components/ui';
import { ExceptionTaskForm } from '@/components/exception-task-form';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { loadExceptionTask } from '@/lib/exception-task-assignment';
import { internalSessionMode } from '@/lib/session';
import { withSerializableTransaction } from '@/lib/serializable';

export const dynamic = 'force-dynamic';
export default async function ExceptionTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission('user.write');
  if (actor.role !== 'admin' || internalSessionMode() !== 'registry') notFound();
  const { id } = await params;
  const task = await withSerializableTransaction(prisma, tx => loadExceptionTask(tx, actor, id));
  if (!task) notFound();
  const users = await prisma.user.findMany({ where: { active: true, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  return <div className="space-y-6"><Card title={task.title}>
    <p>Stato: {task.status}. La riassegnazione conserva lo stato e lo storico dell’attività.</p>
    {['completata', 'annullata'].includes(task.status) ? <p>Riferimento storico: lavoro concluso. Questa operazione non lo riapre.</p> : null}
    <ExceptionTaskForm id={task.id} updatedAt={task.updatedAt.toISOString()} assignedToId={task.assignedToId} users={users} />
  </Card><Link href="/settings/assignment-exceptions?kind=tasks">Torna alla coda attività</Link></div>;
}
