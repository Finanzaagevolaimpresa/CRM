import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getSession } from './auth';
import { isTechnicalAccount } from './technical-confidentiality';
import { technicalPageMode } from './technical-surface-policy';
import { TechnicalSafeNavigation } from '@/components/technical-safe-navigation';

export function withTechnicalPage<P>(route: string, original: (props: P) => ReactNode | Promise<ReactNode> | void) {
  return async function ConfidentialPage(props: P) {
    if (route === '/' || route === '/login') return (await original(props as P)) ?? null;
    const session = await getSession();
    if (!session || !isTechnicalAccount(session)) return (await original(props as P)) ?? null;
    const mode = technicalPageMode(route);
    if (mode === 'denied') notFound();
    if (mode === 'original') return (await original(props as P)) ?? null;
    return TechnicalSafeNavigation({ route, session, props: props as {
      params?: Promise<Record<string, string>>; searchParams?: Promise<Record<string, string>>;
    } });
  };
}
