'use client';
import { useState } from 'react';
export function InternalReadingExpiry({ initial }: { initial?: string | null }) {
  const [value, setValue] = useState(initial ?? '');
  const local = value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0,16) : '';
  return <label className="block">Scadenza facoltativa della lettura CRM
    <input type="hidden" name="internalReadingExpiresAt" value={value}/>
    <input aria-label="Scadenza lettura CRM" type="datetime-local" className="block rounded-xl border p-2" value={local}
      onChange={event => setValue(event.target.value ? new Date(event.target.value).toISOString() : '')}/>
  </label>;
}
