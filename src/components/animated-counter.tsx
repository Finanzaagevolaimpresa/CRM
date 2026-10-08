'use client';

import { useEffect, useRef, type CSSProperties } from 'react';

const segments = [
  '9,2 33,2 38,7 33,12 9,12 4,7',
  '39,9 42,12 42,31 37,36 32,31 32,16',
  '37,40 42,45 42,64 39,67 32,60 32,45',
  '9,64 33,64 38,69 33,74 9,74 4,69',
  '3,40 10,45 10,60 3,67 0,64 0,45',
  '3,9 10,16 10,31 5,36 0,31 0,12',
  '9,33 33,33 38,38 33,43 9,43 4,38',
];
const litSegments = ['012345', '12', '01346', '01236', '1256', '02356', '023456', '012', '0123456', '012356'];

/** Only the decorative readout animates; the accessible value stays exact. */
export function AnimatedCounter({ value }: { value: number }) {
  const visual = useRef<HTMLSpanElement>(null);
  const formatted = value.toLocaleString('it-IT');
  const characters = Array.from(formatted);
  const units = characters.reduce((sum, char) => sum + (/\d/.test(char) ? 0.63 : 0.26), 0);

  useEffect(() => {
    const node = visual.current;
    if (!node) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const cells = Array.from(node.querySelectorAll<SVGSVGElement | HTMLSpanElement>('[data-digit]'));
    let frame = 0;
    let observer: IntersectionObserver | undefined;
    const paint = (text: string) => {
      const aligned = text.padStart(formatted.length, ' ');
      node.dataset.displayValue = text;
      cells.forEach((cell, index) => {
        const char = aligned[index];
        cell.dataset.digit = char;
        if (cell.dataset.separator === 'true') cell.style.visibility = char === ' ' ? 'hidden' : 'visible';
        else cell.querySelectorAll('[data-segment]').forEach((segment, segmentIndex) => {
          segment.setAttribute('data-lit', String(char !== ' ' && litSegments[Number(char)]?.includes(String(segmentIndex)) === true));
        });
      });
    };
    const finish = () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      paint(formatted);
      node.dataset.phase = 'settled';
    };
    const start = () => {
      observer?.disconnect();
      if (preference.matches || value <= 0) { finish(); return; }
      const startedAt = performance.now();
      node.dataset.phase = 'counting';
      paint('0');
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / 850);
        paint(Math.round(value * (1 - (1 - progress) ** 3)).toLocaleString('it-IT'));
        if (progress < 1) frame = requestAnimationFrame(tick);
        else finish();
      };
      frame = requestAnimationFrame(tick);
    };
    // The exact value is also rendered without JS. Below-fold counters animate
    // once when seen, instead of completing their animation off screen.
    if (preference.matches || value <= 0 || !('IntersectionObserver' in window)) finish();
    else {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) start();
      }, { threshold: 0.4 });
      observer.observe(node);
    }
    preference.addEventListener('change', finish);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); preference.removeEventListener('change', finish); };
  }, [value, formatted]);

  return <span data-counter-final={value} className="crm-digital-counter" style={{ '--counter-units': Math.max(units, 1) } as CSSProperties}>
    <span ref={visual} aria-hidden="true" className="crm-digital-visual" data-display-value={formatted} data-phase="settled">
      {characters.map((char, index) => /\d/.test(char)
        ? <svg key={index} data-digit={char} className="crm-digital-digit" viewBox="0 0 44 76" focusable="false">
          {segments.map((points, segmentIndex) => <polygon key={segmentIndex} points={points} data-segment={segmentIndex} data-lit={litSegments[Number(char)].includes(String(segmentIndex))} />)}
        </svg>
        : <span key={index} data-digit={char} data-separator="true" className="crm-digital-separator">{char}</span>)}
    </span>
    <span className="sr-only">{formatted}</span>
  </span>;
}
