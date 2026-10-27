'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';

/** Reselecting the current preview still brings its content into view. Other
 * selections retain the server navigation and its fresh permission checks. */
export function DashboardPreviewLink({ href, label, active, children }: {
  href: string; label: string; active: boolean; children: ReactNode;
}) {
  return <Link href={href} prefetch={false} scroll={false} aria-current={active ? 'true' : undefined}
    aria-controls="dashboard-detail" className="crm-kpi-preview-link" aria-label={`Anteprima: ${label}`}
    onNavigate={() => {
      if (window.location.pathname + window.location.search === href) {
        const detail = document.getElementById('dashboard-detail');
        detail?.focus({ preventScroll: true });
        detail?.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
    }}>{children}</Link>;
}
