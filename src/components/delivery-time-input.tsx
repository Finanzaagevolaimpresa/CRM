'use client';

import { useState, useSyncExternalStore } from 'react';

const subscribe = () => () => {};
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverTimeZone = () => '';

export function DeliveryTimeInput() {
  const timeZone = useSyncExternalStore(subscribe, browserTimeZone, serverTimeZone);
  const [instant, setInstant] = useState('');

  return <label className="grid gap-1">
    Data e ora della consegna {timeZone ? `(${timeZone})` : ''}
    <input name="deliveredAtLocal" type="datetime-local" required disabled={!timeZone}
      className="rounded-xl border p-2" onChange={(event) => {
        const date = new Date(event.currentTarget.value);
        setInstant(Number.isNaN(date.getTime()) ? '' : date.toISOString());
      }}/>
    <input name="deliveredAt" type="hidden" value={instant}/>
  </label>;
}
