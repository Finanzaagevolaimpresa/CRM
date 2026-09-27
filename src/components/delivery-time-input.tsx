'use client';

import { useState, useSyncExternalStore } from 'react';

const subscribe = () => () => {};
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverTimeZone = () => '';

export function DeliveryTimeInput({ label = 'Data e ora della consegna', name = 'deliveredAt' }: { label?: string; name?: string } = {}) {
  const timeZone = useSyncExternalStore(subscribe, browserTimeZone, serverTimeZone);
  const [instant, setInstant] = useState('');

  return <label className="grid gap-1">
    {label} {timeZone ? `(${timeZone})` : ''}
    <input name={`${name}Local`} type="datetime-local" required disabled={!timeZone}
      className="rounded-xl border p-2" onChange={(event) => {
        const date = new Date(event.currentTarget.value);
        setInstant(Number.isNaN(date.getTime()) ? '' : date.toISOString());
      }}/>
    <input name={name} type="hidden" value={instant}/>
  </label>;
}
