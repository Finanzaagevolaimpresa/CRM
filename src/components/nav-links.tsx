'use client';

import type { RoleCode } from '@prisma/client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavItem = {
  label: string;
  href: string;
  adminOnly?: boolean;
};

const items: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Lead', href: '/leads' },
  { label: 'Clienti', href: '/clients' },
  { label: 'Progetti', href: '/projects' },
  { label: 'Documenti', href: '/documents' },
  { label: 'Pre-analisi', href: '/preanalyses' },
  { label: 'Dossier', href: '/dossiers' },
  { label: 'Contratti', href: '/contracts' },
  { label: 'Pagamenti', href: '/payments' },
  { label: 'Task', href: '/tasks' },
  { label: 'AI', href: '/ai' },
  { label: 'Utenti', href: '/settings/users', adminOnly: true },
  { label: 'Ruoli', href: '/settings/roles', adminOnly: true },
  { label: 'Agenti AI', href: '/settings/ai-agents', adminOnly: true },
  { label: 'Diagnostica AI', href: '/settings/ai-diagnostics', adminOnly: true },
  { label: 'Audit log', href: '/audit-log', adminOnly: true },
];

const adminRoles: RoleCode[] = ['admin', 'direzione'];

export function NavLinks({ role }: { role?: RoleCode | null }) {
  const pathname = usePathname();
  const visibleItems = items.filter((item) => !item.adminOnly || (role && adminRoles.includes(role)));

  return <nav className="space-y-1.5">{visibleItems.map(({ label, href }) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return <Link aria-current={active ? 'page' : undefined} className={`group flex items-center justify-between rounded-2xl px-4 py-3 text-sm font-bold ring-1 transition focus:outline-none focus:ring-2 focus:ring-fai-lime ${active ? 'bg-white text-fai-navy shadow-lg shadow-fai-lime/10 ring-white/70' : 'text-white/82 ring-transparent hover:bg-white/12 hover:text-white hover:ring-white/10'}`} href={href} key={href}><span className="flex items-center gap-3"><span className={`h-2 w-2 rounded-full ${active ? 'bg-fai-lime shadow-lg shadow-fai-lime/50' : 'bg-white/20 group-hover:bg-fai-lime'}`} />{label}</span><span className={`transition ${active ? 'text-fai-orange' : 'text-white/25 group-hover:translate-x-1 group-hover:text-fai-lime'}`}>›</span></Link>;
  })}</nav>;
}
