"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { RoleCode } from "@prisma/client";
import type { Permission } from "@/lib/permissions";
import { logoutAction } from "@/lib/login-actions";
import { NavLinks } from "@/components/nav-links";
import { SidebarLogo } from "@/components/sidebar-logo";

export function MobileNavigation({
  role,
  notificationCount = 0,
  effectivePermissions = [],
}: {
  role?: RoleCode | null;
  notificationCount?: number;
  effectivePermissions?: Permission[];
}) {
  const pathname = usePathname();
  return <NavigationForPath key={pathname} role={role} notificationCount={notificationCount} effectivePermissions={effectivePermissions} />;
}

function NavigationForPath({ role, notificationCount, effectivePermissions }: {
  role?: RoleCode | null;
  notificationCount: number;
  effectivePermissions: Permission[];
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const desktopLogoRef = useRef<HTMLAnchorElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  useEffect(() => {
    const mobileQuery = window.matchMedia("(max-width: 767px)");
    const preserveVisibleFocus = (event: MediaQueryListEvent) => {
      const focused = document.activeElement;
      if (event.matches && focused && panelRef.current?.contains(focused)) {
        setOpen(false);
        requestAnimationFrame(() => triggerRef.current?.focus());
      } else if (!event.matches && focused === triggerRef.current) {
        requestAnimationFrame(() => desktopLogoRef.current?.focus());
      }
    };
    mobileQuery.addEventListener("change", preserveVisibleFocus);
    return () => mobileQuery.removeEventListener("change", preserveVisibleFocus);
  }, []);

  const closeAfterNavigation = () => {
    setOpen(false);
    if (window.matchMedia("(max-width: 767px)").matches) {
      triggerRef.current?.focus();
    }
  };

  return (
    <aside className="relative z-30 w-full shrink-0 overflow-hidden bg-fai-navy text-white shadow-xl shadow-fai-navy/20 md:flex md:h-screen md:w-72 md:flex-col md:p-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(128,204,42,.18),transparent_30%),radial-gradient(circle_at_100%_35%,rgba(61,41,116,.32),transparent_30%),linear-gradient(180deg,rgba(5,46,112,.96),rgba(3,31,75,1))]" />
      <div className="relative flex items-center gap-3 p-3 md:hidden">
        <Link
          href="/dashboard"
          onClick={closeAfterNavigation}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl bg-white/95 p-2 focus:outline-none focus:ring-2 focus:ring-fai-lime"
        >
          <SidebarLogo />
          <span className="truncate text-sm font-black text-fai-navy">Gestionale CRM</span>
        </Link>
        <button
          ref={triggerRef}
          type="button"
          aria-controls={panelId}
          aria-expanded={open}
          className="min-h-12 shrink-0 rounded-xl border border-white/25 bg-white/10 px-4 text-sm font-black focus:outline-none focus:ring-2 focus:ring-fai-lime"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Chiudi menu" : "Apri menu"}
        </button>
      </div>
      <div
        ref={panelRef}
        id={panelId}
        className={`${open ? "flex" : "hidden"} relative max-h-[calc(100dvh-4.5rem)] min-h-0 flex-col overflow-hidden px-4 pb-4 md:flex md:max-h-none md:flex-1 md:px-0 md:pb-0`}
      >
        <Link
          ref={desktopLogoRef}
          href="/dashboard"
          className="mb-4 hidden shrink-0 items-center gap-3 rounded-3xl border border-white/12 bg-white/95 p-3 shadow-lg shadow-fai-navy/20 ring-1 ring-fai-lime/15 focus:outline-none focus:ring-2 focus:ring-fai-lime md:flex"
        >
          <SidebarLogo />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-black leading-tight text-fai-navy">Gestionale CRM</span>
            <span className="block whitespace-normal break-words text-xs font-bold leading-snug text-slate-500">Finanza Agevola Impresa</span>
          </span>
        </Link>
        <div className="mb-4 hidden shrink-0 rounded-2xl border border-white/10 bg-white/8 p-3 text-xs leading-5 text-white/72 md:block">
          <span className="font-black uppercase tracking-wide text-fai-lime">Control center</span>
          <br />Pratiche, clienti, AI e compliance in ambiente protetto.
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          <NavLinks effectivePermissions={effectivePermissions} notificationCount={notificationCount} role={role} onNavigate={closeAfterNavigation} />
        </div>
        <form action={logoutAction} className="mt-4 shrink-0 border-t border-white/15 pt-4">
          <button className="w-full rounded-xl bg-white/10 px-4 py-3 text-left text-sm font-bold text-white transition hover:bg-fai-orange focus:outline-none focus:ring-2 focus:ring-fai-lime" type="submit">Logout</button>
        </form>
      </div>
    </aside>
  );
}
