'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const items = [['Dashboard','/dashboard'],['Lead','/leads'],['Clienti','/clients'],['Progetti','/projects'],['Documenti','/documents'],['Pre-analisi','/preanalyses'],['Dossier','/dossiers'],['Contratti','/contracts'],['Pagamenti','/payments'],['Task','/tasks'],['AI','/ai']];

export function NavLinks() {
  const pathname = usePathname();
  return <nav className="space-y-1.5">{items.map(([label, href]) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return <Link aria-current={active ? 'page' : undefined} className={`group flex items-center justify-between rounded-2xl px-4 py-3 text-sm font-bold ring-1 transition focus:outline-none focus:ring-2 focus:ring-fai-lime ${active ? 'bg-white text-fai-navy shadow-lg shadow-fai-lime/10 ring-white/70' : 'text-white/82 ring-transparent hover:bg-white/12 hover:text-white hover:ring-white/10'}`} href={href} key={href}><span className="flex items-center gap-3"><span className={`h-2 w-2 rounded-full ${active ? 'bg-fai-lime shadow-lg shadow-fai-lime/50' : 'bg-white/20 group-hover:bg-fai-lime'}`} />{label}</span><span className={`transition ${active ? 'text-fai-orange' : 'text-white/25 group-hover:translate-x-1 group-hover:text-fai-lime'}`}>›</span></Link>;
  })}</nav>;
}
