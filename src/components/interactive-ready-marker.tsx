'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';

const subscribe = () => () => {};
export function useInteractiveReady() {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

export function InteractiveReadyMarker() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => marker.current?.setAttribute('data-interactive-ready', 'true'), []);
  return <span ref={marker} hidden data-interactive-ready="false" />;
}
