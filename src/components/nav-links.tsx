"use client";

import type { RoleCode } from "@prisma/client";
import type { Permission } from "@/lib/permissions";
import { privilegedAccessPermissions } from "@/lib/privileged-access-contract";
import Link from "next/link";
import { DashboardIcon } from "./dashboard-icon";
import { usePathname } from "next/navigation";

export type NavItem = {
  label: string;
  href: string;
  adminOnly?: boolean;
  roles?: RoleCode[];
  requiredPermission?: Permission;
  requiredAnyPermissions?: Permission[];
};

function NavIcon({ href }: { href: string }) {
  const names: Record<string, string> = { '/dashboard': 'home', '/leads': 'people', '/clients': 'people', '/projects': 'folder',
    '/technical-office': 'gear', '/communications': 'mail', '/documents': 'document', '/videos': 'video', '/settings/account': 'gear', '/search': 'search' };
  return <DashboardIcon name={names[href] ?? 'document'} className="h-5 w-5 shrink-0"/>;
}

type NavSection = {
  title: string;
  items: NavItem[];
};

const sections: NavSection[] = [
  {
    title: "Operatività",
    items: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Il mio account", href: "/settings/account" },
      { label: "Notifiche", href: "/notifications" },
      { label: "Le mie assegnazioni", href: "/assignments", requiredAnyPermissions: ["lead.read", "technical.read"] },
      { label: "Ricerca", href: "/search" },
      { label: "Task", href: "/tasks", requiredPermission: "service.read" },
      { label: "Scadenze", href: "/deadlines", requiredPermission: "service.read" },
      { label: "Documenti", href: "/documents", requiredPermission: "document.download" },
      { label: "Video", href: "/videos", requiredPermission: "video.read" },
      { label: "Checklist documentale", href: "/document-checklists", requiredPermission: "document.download" },
    ],
  },
  {
    title: "Commerciale",
    items: [
      { label: "Lead e offerte", href: "/leads", requiredPermission: "lead.read" },
      { label: "Acquisizione lead", href: "/leads/acquisition", adminOnly: true },
      { label: "Acquisizioni controllate", href: "/controlled-intakes", requiredPermission: "lead.read" },
      { label: "Revisione duplicati", href: "/leads/duplicates", requiredPermission: "lead.duplicate.resolve" },
      { label: "Offerte", href: "/commercial-offers", requiredPermission: "lead.read" },
      { label: "Contratti", href: "/contracts", requiredPermission: "contract.read" },
      { label: "Pagamenti", href: "/payments", requiredPermission: "payment.read" },
    ],
  },
  {
    title: "Clienti e pratiche",
    items: [
      { label: "Clienti", href: "/clients", requiredPermission: "client.read" },
      { label: "Progetti", href: "/projects", requiredPermission: "project.read" },
      { label: "Progetti condivisi", href: "/shared-projects" },
      { label: "Pre-analisi", href: "/preanalyses", requiredPermission: "dossier.read" },
      { label: "Dossier", href: "/dossiers", requiredPermission: "dossier.read" },
      { label: "Catalogo servizi", href: "/service-catalog", requiredPermission: "service.read" },
      { label: "Pratiche da avviare", href: "/practice-readiness", requiredPermission: "service.read" },
      { label: "Comunicazioni", href: "/communications", requiredAnyPermissions: ["practice_communications.read", "communications.internal.read"] },
      { label: "Caselle e risposte", href: "/settings/communications", adminOnly: true },
    ],
  },
  {
    title: "Ufficio Tecnico",
    items: [
      { label: "Ufficio Tecnico", href: "/technical-office", requiredPermission: "technical.read" },
      { label: "Pratiche tecniche", href: "/technical-office/practices", requiredPermission: "technical.read" },
      { label: "Enti / Portali", href: "/technical-office/portals", requiredPermission: "technical.read" },
      { label: "Integrazioni", href: "/technical-office/integrations", requiredPermission: "technical.read" },
      { label: "Rendicontazioni", href: "/technical-office/reporting", requiredPermission: "technical.read" },
    ],
  },
  {
    title: "AI",
    items: [
      { label: "Control center AI", href: "/ai", requiredPermission: "ai.review" },
      { label: "Autorizzazioni AI", href: "/settings/ai-authorizations", requiredAnyPermissions: ["ai.execution.request", "ai.execution.audit"] },
      { label: "Output AI", href: "/ai/outputs", requiredPermission: "ai.review" },
      { label: "Dossier AI / Bozze", href: "/client-dossiers", requiredPermission: "dossier.read" },
      { label: "Agenti AI", href: "/settings/ai-agents", requiredPermission: "ai_agents.read" },
    ],
  },
  {
    title: "Legale / Compliance",
    items: [
      { label: "Legale / Compliance", href: "/legal-compliance", requiredPermission: "legal.read" },
      { label: "Contratti da revisionare", href: "/legal-compliance/contracts", requiredPermission: "legal.read" },
      { label: "PEC / Contestazioni", href: "/legal-compliance/disputes", requiredPermission: "legal.read" },
      { label: "Privacy e consensi", href: "/legal-compliance/privacy", requiredPermission: "privacy.evidence.read" },
    ],
  },
  {
    title: "Admin / Sistema",
    items: [
      { label: "Utenti", href: "/settings/users", requiredPermission: "user.read" },
      { label: "Sicurezza privilegiata", href: "/settings/security", requiredAnyPermissions: [...privilegedAccessPermissions] },
      { label: "Ruoli", href: "/settings/roles", requiredPermission: "settings.manage" },
      { label: "Orchestrator AI", href: "/settings/ai-orchestrator", requiredPermission: "ai.orchestrator.read" },
      { label: "Diagnostica sistema", href: "/settings/system", requiredPermission: "settings.manage" },
      {
        label: "Diagnostica AI",
        href: "/settings/ai-diagnostics",
        requiredPermission: "ai_agents.read",
      },
      { label: "Audit log", href: "/audit-log", requiredPermission: "audit.read" },
    ],
  },
];

const adminRoles: RoleCode[] = ["admin", "direzione"];


export function getVisibleNavItems({ role, effectivePermissions = [] }: { role?: RoleCode | null; effectivePermissions?: Permission[] }) {
  const canSeeAdmin = Boolean(role && adminRoles.includes(role));
  const effectivePermissionSet = new Set(effectivePermissions);
  return sections.flatMap((section) => {
    const visibleItems = section.items.filter((item) => {
      if (item.adminOnly && !canSeeAdmin) return false;
      if (item.roles && (!role || !item.roles.includes(role))) return false;
      if (item.requiredPermission && !effectivePermissionSet.has(item.requiredPermission)) return false;
      if (item.requiredAnyPermissions && !item.requiredAnyPermissions.some((permission) => effectivePermissionSet.has(permission))) return false;
      return true;
    });
    return visibleItems.length ? [{ ...section, items: visibleItems }] : [];
  });
}

export function NavLinks({
  role,
  notificationCount = 0,
  effectivePermissions = [],
  onNavigate,
}: {
  role?: RoleCode | null;
  notificationCount?: number;
  effectivePermissions?: Permission[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const visibleSections = getVisibleNavItems({ role, effectivePermissions });
  const all = visibleSections.flatMap(section => section.items);
  const primaryPaths = ["/dashboard", "/leads", "/clients", "/projects", "/technical-office", "/communications", "/documents", "/videos", "/settings/account"];
  const primary = primaryPaths.flatMap(path => all.filter(item => item.href === path));
  // Keep every existing destination and permission predicate; promote the nine
  // reference entries without duplicating them or granting new navigation.
  const renderItem = ({ label, href }: NavItem, isPrimary = false) => {
    const active = pathname === href || (pathname.startsWith(`${href}/`) && !all.some(item => item.href !== href && item.href.length > href.length && (pathname === item.href || pathname.startsWith(`${item.href}/`))));
    const displayLabel = isPrimary && href === '/settings/account' ? 'Impostazioni' : isPrimary && href === '/leads' ? 'Lead' : label;
    return <Link aria-current={active ? "page" : undefined} className="crm-nav-link group flex min-h-11 items-center justify-between rounded-xl px-3 py-2 text-sm font-bold transition focus:outline-compat focus:ring-2 focus:ring-fai-lime" href={href} key={href} onClick={onNavigate}>
      <span className="flex min-w-0 flex-1 items-center gap-2.5"><NavIcon href={href}/><span className="line-clamp-2 whitespace-normal break-words leading-snug">{displayLabel}</span></span>
      {href === '/notifications' && notificationCount > 0 ? <span className="ml-2 shrink-0 rounded-full bg-fai-orange px-2 py-0.5 text-[0.65rem] font-black text-white">{notificationCount > 99 ? '99+' : notificationCount}</span> : <span aria-hidden="true" className="crm-nav-arrow ml-2 shrink-0 text-lg">›</span>}
    </Link>;
  };
  return <nav className="crm-space-y-4 pb-1" aria-label="Navigazione principale">
    <div className="crm-nav-primary">{primary.map(item => renderItem(item, true))}</div>
    {visibleSections.map(section => {
      const secondary = section.items.filter(item => !primaryPaths.includes(item.href));
      return secondary.length ? <div key={section.title} className="crm-space-y-1.5"><p className="crm-nav-section-title px-3 pt-2 text-[0.62rem] font-black uppercase tracking-[0.16em]">{section.title}</p>{secondary.map(item => renderItem(item))}</div> : null;
    })}
  </nav>;
}


export function visibleNavItemsForTest({ role, effectivePermissions = [] }: { role?: RoleCode | null; effectivePermissions?: Permission[] }) {
  return getVisibleNavItems({ role, effectivePermissions }).flatMap((section) => section.items.map((item) => item.href));
}
