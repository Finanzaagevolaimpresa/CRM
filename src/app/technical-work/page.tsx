import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { OperationalWorkList } from '@/components/operational-work-list';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession(), query = await searchParams;
  const kind = z.enum(['Project', 'TechnicalPractice']).safeParse(query.kind ?? 'TechnicalPractice');
  if (!kind.success) notFound();
  return <OperationalWorkList session={session} kind={kind.data}
    path="/technical-work" title="I miei incarichi tecnici" query={query} />;
}
