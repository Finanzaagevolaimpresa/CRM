'use client';
import { useEffect } from 'react';

export function DashboardSelectionFocus({ selection }: { selection?: string | null }) {
  useEffect(() => {
    if (!selection) return;
    const detail = document.getElementById('dashboard-detail');
    detail?.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 1050px)').matches) detail?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [selection]);
  return null;
}
