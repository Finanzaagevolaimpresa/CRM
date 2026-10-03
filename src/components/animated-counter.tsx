'use client';

import { useEffect, useRef } from 'react';

/** Only the decorative copy animates; the accessible value is always the real total. */
export function AnimatedCounter({ value }: { value: number }) {
  const visual = useRef<HTMLSpanElement>(null);
  const formatted = value.toLocaleString('it-IT');
  useEffect(() => {
    const node = visual.current;
    if (!node) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const finish = () => { cancelAnimationFrame(frame); node.textContent = formatted; };
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 650);
      node.textContent = Math.round(value * (1 - (1 - progress) ** 3)).toLocaleString('it-IT');
      if (progress < 1) frame = requestAnimationFrame(tick);
      else finish();
    };
    if (!preference.matches && value > 0) frame = requestAnimationFrame(tick);
    else finish();
    preference.addEventListener('change', finish);
    return () => { finish(); preference.removeEventListener('change', finish); };
  }, [value, formatted]);
  return <span data-counter-final={value} className="font-mono tabular-nums">
    <span ref={visual} aria-hidden="true">{formatted}</span><span className="sr-only">{formatted}</span>
  </span>;
}
