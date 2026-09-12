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
  const mobileLogoRef = useRef<HTMLAnchorElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
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
    let focusFrame = 0;
    const preserveVisibleFocus = (event: MediaQueryListEvent) => {
      cancelAnimationFrame(focusFrame);
      const active = document.activeElement;
      // CSS may blur a control before the media-query change event is delivered.
      const hiddenPreviousFocus = lastFocusedRef.current;
      const focused = active === document.body && hiddenPreviousFocus?.getClientRects().length === 0
        ? hiddenPreviousFocus
        : active;
      if (event.matches && focused && panelRef.current?.contains(focused)) {
        setOpen(false);
        focusFrame = requestAnimationFrame(() => triggerRef.current?.focus());
      } else if (!event.matches && (focused === triggerRef.current || focused === mobileLogoRef.current)) {
        focusFrame = requestAnimationFrame(() => desktopLogoRef.current?.focus());
      }
    };
    mobileQuery.addEventListener("change", preserveVisibleFocus);
    return () => {
      mobileQuery.removeEventListener("change", preserveVisibleFocus);
      cancelAnimationFrame(focusFrame);
    };
  }, []);

  const closeAfterNavigation = () => {
    setOpen(false);
    if (window.matchMedia("(max-width: 767px)").matches) {
      triggerRef.current?.focus();
    }
  };

  return (
    <aside
      onFocusCapture={(event) => { lastFocusedRef.current = event.target; }}
      onBlurCapture={(event) => {
        // Keep only focus lost because a responsive rule hid the control.
        if (event.relatedTarget || event.target.getClientRects().length > 0) {
          lastFocusedRef.current = null;
        }
      }}
      className="relative z-30 w-full shrink-0 overflow-hidden bg-fai-navy text-white shadow-xl shadow-fai-navy/20 md:flex md:h-screen md:w-64 md:flex-col md:p-4"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,rgba(128,204,42,.12),transparent_28%),linear-gradient(180deg,#052e70,#062958)]" />
      <div className="relative flex items-center gap-3 p-3 md:hidden">
        <Link
          ref={mobileLogoRef}
          href="/dashboard"
          onClick={closeAfterNavigation}
          className="flex min-w-0 flex-1 items-center rounded-xl focus:outline-none focus:ring-2 focus:ring-fai-lime"
        >
          <SidebarLogo compact />
          <span className="sr-only">Gestionale CRM</span>
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
          className="mb-3 hidden shrink-0 rounded-2xl focus:outline-none focus:ring-2 focus:ring-fai-lime md:flex"
        >
          <SidebarLogo />
          <span className="sr-only">Gestionale CRM</span>
        </Link>
        <div className="mb-4 hidden shrink-0 px-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-white/55 md:block">
          Gestionale CRM interno
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          <NavLinks effectivePermissions={effectivePermissions} notificationCount={notificationCount} role={role} onNavigate={closeAfterNavigation} />
        </div>
        <form action={logoutAction} className="mt-3 shrink-0 border-t border-white/15 pt-3">
          <button className="min-h-11 w-full rounded-xl bg-white/8 px-3 py-2 text-left text-sm font-bold text-white transition hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-fai-lime" type="submit">Esci dal CRM</button>
        </form>
      </div>
    </aside>
  );
}
