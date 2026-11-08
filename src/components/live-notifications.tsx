'use client';
import { createContext, useContext, useEffect, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
const Count = createContext<number | null>(null);
export function LiveNotifications({ children, initialCount, actorId }: { children: ReactNode; initialCount: number; actorId: string | null }) {
  const [count, setCount] = useState(initialCount);
  useEffect(() => {
    if (!actorId) return;
    let alive = true, busy = false;
    let request: AbortController | null = null;
    const read = async () => {
      if (!alive || busy || document.hidden) return;
      busy = true; request = new AbortController();
      const timer = setTimeout(() => request?.abort(), 10_000);
      try {
        const response = await fetch('/api/notifications/count', { cache: 'no-store', credentials: 'same-origin', signal: request.signal });
        const data = response.ok ? await response.json() as { count: number } : null;
        if (alive) setCount(data && Number.isSafeInteger(data.count) && data.count >= 0 ? data.count : 0);
      } catch { if (alive) setCount(0); }
      finally { clearTimeout(timer); busy = false; }
    };
    void read();
    const poll = () => { void read(); }, timer = setInterval(poll, 3000);
    document.addEventListener('visibilitychange', poll); window.addEventListener('fai-notifications-changed', poll);
    return () => { alive = false; clearInterval(timer); request?.abort();
      document.removeEventListener('visibilitychange', poll); window.removeEventListener('fai-notifications-changed', poll); };
  }, [actorId]);
  return <Count.Provider value={count}>{children}</Count.Provider>;
}
export function useLiveNotificationCount(fallback: number) { return useContext(Count) ?? fallback; }
export function NotificationCountText({ initialCount }: { initialCount: number }) {
  const count = useLiveNotificationCount(initialCount);
  return <span aria-live="polite">{count > 0 ? ' · ' + (count > 99 ? '99+' : count) : ''}</span>;
}
/** Only for read-only notice pages. Editable record forms use an isolated GET
 * projection instead, so no refresh can discard their draft or selections. */
export function RefreshReadOnlyNotices() {
  const router = useRouter(), [pending, startTransition] = useTransition();
  useEffect(() => {
    const refresh = () => { if (!document.hidden && !pending) startTransition(() => router.refresh()); };
    const timer = setInterval(refresh, 3000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [pending, router]);
  return null;
}
