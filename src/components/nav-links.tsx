"use client";

import type { RoleCode } from "@prisma/client";
import type { Permission } from "@/lib/auth";
import { isNavItemVisible } from "@/lib/nav-visibility";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  label: string;
  href: string;
  adminOnly?: boolean;
  roles?: RoleCode[];
  permission?: Permission;
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
      { label: "Task", href: "/tasks", permission: "service.read" },
      { label: "Scadenze", href: "/deadlines", permission: "service.read" },
      { label: "Documenti", href: "/documents", permission: "document.download" },
      { label: "Checklist documentale", href: "/document-checklists", permission: "service.read" },
    ],
  },
  {
    title: "Commerciale",
    items: [
      { label: "Lead e offerte", href: "/leads", permission: "lead.read" },
      { label: "Offerte", href: "/commercial-offers", permission: "lead.read" },
      { label: "Contratti", href: "/contracts", permission: "contract.read" },
      { label: "Pagamenti", href: "/payments", permission: "payment.read" },
    ],
  },
  {
    title: "Clienti e pratiche",
    items: [
      { label: "Clienti", href: "/clients", permission: "client.read" },
      { label: "Progetti", href: "/projects", permission: "project.read" },
      { label: "Pre-analisi", href: "/preanalyses", permission: "dossier.read" },
      { label: "Dossier", href: "/dossiers", permission: "dossier.read" },
    ],
  },
  {
    title: "Ufficio Tecnico",
    items: [
      {
        label: "Ufficio Tecnico",
        href: "/technical-office",
        permission: "technical.read",
      },
      { label: "Pratiche tecniche", href: "/technical-office/practices", permission: "technical.read" },
      { label: "Enti / Portali", href: "/technical-office/portals", permission: "technical.read" },
      { label: "Integrazioni", href: "/technical-office/integrations", permission: "technical.read" },
      { label: "Rendicontazioni", href: "/technical-office/reporting", permission: "technical.read" },
    ],
  },
  {
    title: "AI",
    items: [
      { label: "Control center AI", href: "/ai", permission: "ai.run" },
      { label: "Output AI", href: "/ai/outputs", permission: "ai.review" },
      { label: "Dossier AI / Bozze", href: "/client-dossiers", permission: "dossier.read" },
      { label: "Agenti AI", href: "/settings/ai-agents", adminOnly: true, permission: "ai_agents.read" },
    ],
  },
  {
    title: "Legale / Compliance",
    items: [
      {
        label: "Legale / Compliance",
        href: "/legal-compliance",
        permission: "contract.read",
      },
      { label: "Contratti da revisionare", href: "/legal-compliance/contracts", permission: "contract.read" },
      { label: "PEC / Contestazioni", href: "/legal-compliance/disputes", permission: "contract.read" },
      { label: "Privacy e consensi", href: "/legal-compliance/privacy", permission: "contract.read" },
    ],
  },
  {
    title: "Admin / Sistema",
    items: [
      { label: "Utenti", href: "/settings/users", adminOnly: true, permission: "settings.manage" },
      { label: "Ruoli", href: "/settings/roles", adminOnly: true, permission: "settings.manage" },
      { label: "Diagnostica sistema", href: "/settings/system", adminOnly: true, permission: "settings.manage" },
      {
        label: "Diagnostica AI",
        href: "/settings/ai-diagnostics",
        adminOnly: true,
        permission: "ai_agents.read",
      },
      { label: "Audit log", href: "/audit-log", adminOnly: true, permission: "audit.read" },
    ],
  },
];


export function NavLinks({
  role,
  notificationCount = 0,
  permissions = [],
}: {
  role?: RoleCode | null;
  notificationCount?: number;
  permissions?: readonly Permission[];
}) {
  const pathname = usePathname();
  return (
    <nav className="space-y-4 pb-1" aria-label="Navigazione principale">
      {sections.map((section) => {
        const visibleItems = section.items.filter((item) => {
          return isNavItemVisible(item, { role, permissions });
        });
        if (visibleItems.length === 0) return null;

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
