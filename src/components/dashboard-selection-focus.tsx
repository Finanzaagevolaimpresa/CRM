'use client';
import { useEffect, useRef } from 'react';

export function DashboardSelectionFocus({ selection }: { selection?: string | null }) {
  const ready = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (selection) {
      const detail = document.getElementById('dashboard-detail');
      detail?.focus({ preventScroll: true });
      if (window.matchMedia('(max-width: 1050px)').matches) detail?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
    // The root layout can hydrate while the streamed dashboard is still pending.
    ready.current?.setAttribute('data-dashboard-ready', 'true');
  }, [selection]);
  return <span ref={ready} hidden data-dashboard-ready="false" />;
}
