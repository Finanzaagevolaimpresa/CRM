"use client";

import type { RoleCode } from "@prisma/client";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  label: string;
  href: string;
  adminOnly?: boolean;
  roles?: RoleCode[];
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const operationalRoles: RoleCode[] = [
  "admin",
  "direzione",
  "consulente",
  "revisore",
  "backoffice",
];
const legalComplianceRoles: RoleCode[] = [
  "admin",
  "direzione",
  "revisore",
  "amministrazione",
];

const sections: NavSection[] = [
  {
    title: "Operatività",
    items: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Task", href: "/tasks" },
      { label: "Scadenze", href: "/deadlines" },
      { label: "Documenti", href: "/documents" },
      { label: "Checklist documentale", href: "/document-checklists" },
    ],
  },
  {
    title: "Commerciale",
    items: [
      { label: "Lead e offerte", href: "/leads" },
      { label: "Offerte", href: "/commercial-offers" },
      { label: "Contratti", href: "/contracts" },
      { label: "Pagamenti", href: "/payments" },
    ],
  },
  {
    title: "Clienti e pratiche",
    items: [
      { label: "Clienti", href: "/clients" },
      { label: "Progetti", href: "/projects" },
      { label: "Pre-analisi", href: "/preanalyses" },
      { label: "Dossier", href: "/dossiers" },
    ],
  },
  {
    title: "Ufficio Tecnico",
    items: [
      {
        label: "Ufficio Tecnico",
        href: "/technical-office",
        roles: operationalRoles,
      },
      { label: "Pratiche tecniche", href: "/technical-office/practices", roles: operationalRoles },
      { label: "Enti / Portali", href: "/technical-office/portals", roles: operationalRoles },
      { label: "Integrazioni", href: "/technical-office/integrations", roles: operationalRoles },
      { label: "Rendicontazioni", href: "/technical-office/reporting", roles: operationalRoles },
    ],
  },
  {
    title: "AI",
    items: [
      { label: "Control center AI", href: "/ai" },
      { label: "Output AI", href: "/ai/outputs" },
      { label: "Dossier AI / Bozze", href: "/client-dossiers" },
      { label: "Agenti AI", href: "/settings/ai-agents", adminOnly: true },
    ],
  },
  {
    title: "Legale / Compliance",
    items: [
      {
        label: "Legale / Compliance",
        href: "/legal-compliance",
        roles: legalComplianceRoles,
      },
      { label: "Contratti da revisionare", href: "/legal-compliance/contracts", roles: legalComplianceRoles },
      { label: "PEC / Contestazioni", href: "/legal-compliance/disputes", roles: legalComplianceRoles },
      { label: "Privacy e consensi", href: "/legal-compliance/privacy", roles: legalComplianceRoles },
    ],
  },
  {
    title: "Admin / Sistema",
    items: [
      { label: "Utenti", href: "/settings/users", adminOnly: true },
      { label: "Ruoli", href: "/settings/roles", adminOnly: true },
      {
        label: "Diagnostica AI",
        href: "/settings/ai-diagnostics",
        adminOnly: true,
      },
      { label: "Audit log", href: "/audit-log", adminOnly: true },
    ],
  },
];

const adminRoles: RoleCode[] = ["admin", "direzione"];

export function NavLinks({ role }: { role?: RoleCode | null }) {
  const pathname = usePathname();
  const canSeeAdmin = Boolean(role && adminRoles.includes(role));

  return (
    <nav className="space-y-4 pb-1" aria-label="Navigazione principale">
      {sections.map((section) => {
        const visibleItems = section.items.filter((item) => {
          if (item.adminOnly && !canSeeAdmin) return false;
          if (item.roles && (!role || !item.roles.includes(role))) return false;
          return true;
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
                  <span
                    className={`ml-2 shrink-0 text-xs transition ${active ? "text-fai-orange" : "text-white/20 group-hover:translate-x-0.5 group-hover:text-fai-lime"}`}
                  >
                    ›
                  </span>
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
