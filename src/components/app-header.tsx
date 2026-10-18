'use client';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function AppHeader({ children }: { children: ReactNode }) {
  // The dashboard has its own compact profile/perimeter header. Other screens
  // retain all existing search, notification and role controls.
  return usePathname() === '/dashboard' ? null : children;
}
