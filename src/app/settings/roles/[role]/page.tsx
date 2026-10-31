import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { PageHeader } from '@/components/ui';
import { profileRole } from '@/lib/admin-role-profile-contract';
import { readAdminRoleProfile } from '@/lib/admin-role-profiles';
import { AdminRoleProfileEditor } from '@/components/admin-role-profile-editor';
export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
  params: Promise<{ role: string }>; searchParams: Promise<{ command?: string; decision?: string; page?: string }>;
}) {
  const session = await requireAuth(['admin']), { role } = await params, query = await searchParams;
  if (!profileRole.safeParse(role).success || query.decision && !z.string().uuid().safeParse(query.decision).success) notFound();
  const page = Number(query.page ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > 10000) notFound();
  if (query.command && !z.string().uuid().safeParse(query.command).success || query.command && query.decision && query.command !== query.decision) notFound();
  if (!query.command) {
    const next = new URLSearchParams({ command: query.decision ?? randomUUID(), page: String(page) });
    if (query.decision) next.set('decision', query.decision);
    redirect('/settings/roles/' + role + '?' + next);
  }
  const data = await readAdminRoleProfile(prisma, session, role, page);
  return <div className="space-y-6"><PageHeader title="Profilo operativo del ruolo" description="Scegli i permessi di base per i nuovi account; conserva versioni, motivazione e possibilità di ripristino."/>
    <AdminRoleProfileEditor key={role + ':' + query.command} data={data} commandId={query.command} recovering={Boolean(query.decision)}/>
  </div>;
}
