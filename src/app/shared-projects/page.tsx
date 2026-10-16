export const dynamic = 'force-dynamic';
export const revalidate = 0;
import Link from 'next/link';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readSelectiveProject } from '@/lib/selective-project-access';

export default async function Page() {
  const session = await requireSession();
  const items = [];
  for (const id of session.selectiveProjectIds ?? []) {
    const projection = await readSelectiveProject(prisma, session, id).catch(() => null);
    if (projection) items.push(projection);
  }
  return <div className="space-y-5"><h1 className="text-3xl font-bold">Progetti condivisi con te</h1>
    {!items.length && <p>Nessun accesso selettivo disponibile.</p>}
    <ul className="space-y-3">{items.map(item => <li key={item.projectId}><Link className="underline" href={`/shared-projects/${item.projectId}`}>{item.fields.find(field => field.key === 'title')?.value ?? 'Progetto condiviso'}</Link></li>)}</ul>
  </div>;
}
