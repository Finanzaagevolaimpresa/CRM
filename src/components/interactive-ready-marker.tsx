'use client';

import { useEffect, useRef } from 'react';

export function InteractiveReadyMarker() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => marker.current?.setAttribute('data-interactive-ready', 'true'), []);
  return <span ref={marker} hidden data-interactive-ready="false" />;
}
