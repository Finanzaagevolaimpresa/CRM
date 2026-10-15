export const dynamic = 'force-dynamic';
export const revalidate = 0;
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readSelectiveProject } from '@/lib/selective-project-access';
import { SelectiveProjectView } from '@/components/selective-project-view';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(), { id } = await params;
  const projection = await readSelectiveProject(prisma, session, id).catch(() => null);
  if (!projection) notFound();
  return <div className="space-y-5"><h1 className="text-3xl font-bold">Progetto condiviso</h1><SelectiveProjectView projection={projection} /></div>;
}
