'use client';

import type { RoleCode } from '@prisma/client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavItem = {
  label: string;
  href: string;
  adminOnly?: boolean;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const sections: NavSection[] = [
  {
    title: 'Operatività',
    items: [
      { label: 'Dashboard', href: '/dashboard' },
      { label: 'Task', href: '/tasks' },
      { label: 'Documenti', href: '/documents' },
    ],
  },
  {
    title: 'Commerciale',
    items: [
      { label: 'Lead e offerte', href: '/leads' },
      { label: 'Contratti', href: '/contracts' },
      { label: 'Pagamenti', href: '/payments' },
    ],
  },
  {
    title: 'Clienti e pratiche',
    items: [
      { label: 'Clienti', href: '/clients' },
      { label: 'Progetti', href: '/projects' },
      { label: 'Pre-analisi', href: '/preanalyses' },
      { label: 'Dossier', href: '/dossiers' },
    ],
  },
  {
    title: 'AI',
    items: [{ label: 'Control center AI', href: '/ai' }],
  },
  {
    title: 'Admin/Sistema',
    items: [
      { label: 'Utenti', href: '/settings/users', adminOnly: true },
      { label: 'Ruoli', href: '/settings/roles', adminOnly: true },
      { label: 'Agenti AI', href: '/settings/ai-agents', adminOnly: true },
      { label: 'Diagnostica AI', href: '/settings/ai-diagnostics', adminOnly: true },
      { label: 'Audit log', href: '/audit-log', adminOnly: true },
    ],
  },
];

const adminRoles: RoleCode[] = ['admin', 'direzione'];

export function NavLinks({ role }: { role?: RoleCode | null }) {
  const pathname = usePathname();
  const canSeeAdmin = Boolean(role && adminRoles.includes(role));

  return <nav className="space-y-4" aria-label="Navigazione principale">{sections.map((section) => {
    const visibleItems = section.items.filter((item) => !item.adminOnly || canSeeAdmin);
    if (visibleItems.length === 0) return null;

    return <div key={section.title} className="space-y-1.5">
      <p className="px-3 text-[0.65rem] font-black uppercase tracking-[0.18em] text-white/45">{section.title}</p>
      {visibleItems.map(({ label, href }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return <Link aria-current={active ? 'page' : undefined} className={`group flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-bold ring-1 transition focus:outline-none focus:ring-2 focus:ring-fai-lime ${active ? 'bg-white text-fai-navy shadow-md shadow-fai-lime/10 ring-white/80' : 'text-white/78 ring-transparent hover:bg-white/10 hover:text-white hover:ring-white/10'}`} href={href} key={href}>
          <span className="flex min-w-0 items-center gap-2.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'bg-fai-orange shadow-sm shadow-fai-orange/40' : 'bg-white/18 group-hover:bg-fai-lime'}`} />
            <span className="truncate">{label}</span>
          </span>
          <span className={`text-xs transition ${active ? 'text-fai-orange' : 'text-white/20 group-hover:translate-x-0.5 group-hover:text-fai-lime'}`}>›</span>
        </Link>;
      })}
    </div>;
  })}</nav>;
}
