import { notFound } from 'next/navigation';
import { Card } from '@/components/ui';
import { UserAccountForms } from '@/components/user-account-forms';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { internalSessionMode } from '@/lib/session';

export default async function AccountPage() {
  const session = await requireSession();
  const user = await prisma.user.findFirst({
    where: { id: session.userId, active: true, deletedAt: null },
    select: { id: true, name: true, email: true },
  });
  if (!user) notFound();
  return <Card title="Il mio account"><UserAccountForms user={user} own admin={session.role === 'admin'} available={internalSessionMode() === 'registry'} /></Card>;
}
