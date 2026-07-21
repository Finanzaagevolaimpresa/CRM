"use client";

import type { RoleCode } from "@prisma/client";
import type { Permission } from "@/lib/permissions";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = {
  label: string;
  href: string;
  adminOnly?: boolean;
  roles?: RoleCode[];
  requiredPermission?: Permission;
  requiredAnyPermissions?: Permission[];
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const sections: NavSection[] = [
  {
    title: "Operatività",
    items: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Notifiche", href: "/notifications" },
      { label: "Ricerca", href: "/search" },
      { label: "Task", href: "/tasks", requiredPermission: "service.read" },
      { label: "Scadenze", href: "/deadlines", requiredPermission: "service.read" },
      { label: "Documenti", href: "/documents", requiredPermission: "document.download" },
      { label: "Checklist documentale", href: "/document-checklists", requiredPermission: "document.download" },
    ],
  },
  {
    title: "Commerciale",
    items: [
      { label: "Lead e offerte", href: "/leads", requiredPermission: "lead.read" },
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
      { label: "Pre-analisi", href: "/preanalyses", requiredPermission: "dossier.read" },
      { label: "Dossier", href: "/dossiers", requiredPermission: "dossier.read" },
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
      { label: "Privacy e consensi", href: "/legal-compliance/privacy", requiredPermission: "legal.read" },
    ],
  },
  {
    title: "Admin / Sistema",
    items: [
      { label: "Utenti", href: "/settings/users", requiredPermission: "user.read" },
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
}: {
  role?: RoleCode | null;
  notificationCount?: number;
  effectivePermissions?: Permission[];
}) {
  const pathname = usePathname();
  return (
    <nav className="space-y-4 pb-1" aria-label="Navigazione principale">
      {getVisibleNavItems({ role, effectivePermissions }).map((section) => {
        const visibleItems = section.items;
        return (
          <div key={section.title} className="space-y-1.5">
            <p className="px-3 text-[0.65rem] font-black uppercase tracking-[0.18em] text-white/45">
              {section.title}
            </p>
            {visibleItems.map(({ label, href }) => {
              const active =
                pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={`group flex min-h-12 items-center justify-between rounded-xl px-3 py-3 text-sm font-bold ring-1 transition focus:outline-none focus:ring-2 focus:ring-fai-lime ${active ? "bg-white text-fai-navy shadow-md shadow-fai-lime/10 ring-white/80" : "text-white/82 ring-transparent hover:bg-white/10 hover:text-white hover:ring-white/10"}`}
                  href={href}
                  key={href}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2.5">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${active ? "bg-fai-orange shadow-sm shadow-fai-orange/40" : "bg-white/18 group-hover:bg-fai-lime"}`}
                    />
                    <span className="line-clamp-2 whitespace-normal break-words leading-snug">
                      {label}
                    </span>
                  </span>
                  {href === "/notifications" && notificationCount > 0 ? (
                    <span className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-black ${active ? "bg-fai-orange text-white" : "bg-fai-orange text-white"}`}>
                      {notificationCount > 99 ? "99+" : notificationCount}
                    </span>
                  ) : (
                    <span
                      className={`ml-2 shrink-0 text-xs transition ${active ? "text-fai-orange" : "text-white/20 group-hover:translate-x-0.5 group-hover:text-fai-lime"}`}
                    >
                      ›
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}


export function visibleNavItemsForTest({ role, effectivePermissions = [] }: { role?: RoleCode | null; effectivePermissions?: Permission[] }) {
  return getVisibleNavItems({ role, effectivePermissions }).flatMap((section) => section.items.map((item) => item.href));
}
