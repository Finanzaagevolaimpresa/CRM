import { notFound } from 'next/navigation';
import { getSession } from './auth';
import { isTechnicalAccount } from './technical-confidentiality';
import { technicalActionAllowed, technicalFileRouteAllowed } from './technical-surface-policy';

export async function assertTechnicalFileRoute(route: string) {
  const session = await getSession();
  if (session && isTechnicalAccount(session) && !technicalFileRouteAllowed(route)) notFound();
}
export async function assertTechnicalServerAction(action: string) {
  const session = await getSession();
  if (session && !technicalActionAllowed(session, action)) notFound();
}
