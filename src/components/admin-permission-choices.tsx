'use client';
import { useState } from 'react';
import type { PermissionSession } from '@/lib/permission-evaluator';
import { permissionOverrideControl } from '@/lib/permission-evaluator';
import { permissionCatalog } from '@/lib/permissions';
import { Badge, Card } from './ui';

export function AdminPermissionChoices({ actor, canEdit }: { actor: PermissionSession; canEdit: boolean }) {
  const [overrides, setOverrides] = useState(actor.permissionOverrides);
  const current = { ...actor, permissionOverrides: overrides };
  const groups = [...new Set(permissionCatalog.map(item => item.group))];
  return <div className="space-y-4">
    <p>I selettori non modificabili conservano la scelta già registrata quando salvi gli altri permessi. Il limite effettivo del ruolo resta applicato.</p>
    {!actor.active && <p>L’account è inattivo. Puoi preparare i permessi; l’accesso resta negato finché non lo riattivi.</p>}
    {groups.map(group => <Card title={group} key={group}><div className="space-y-3">
      {permissionCatalog.filter(item => item.group === group).map(item => {
        const control = permissionOverrideControl(current, item.code);
        const stored = overrides.find(value => value.permission === item.code);
        return <div key={item.code} data-permission-code={item.code} className="grid gap-2 rounded-2xl border p-3 md:grid-cols-[1fr_auto_auto_auto]">
          <div><p className="font-black">{item.label} <code className="text-xs text-slate-500">{item.code}</code></p>
            <p className="text-sm">{item.description}</p><p className="text-sm">{control.reason}</p></div>
          <Badge tone={control.inherited ? 'green' : 'gray'}>Ereditato: {control.inherited ? 'sì' : 'no'}</Badge>
          <label>Scelta · {item.label}<select name={'permission:' + item.code} aria-label={'Permesso · ' + item.label}
            disabled={!canEdit || !control.editable} value={stored === undefined ? 'inherit' : stored.allowed ? 'allow' : 'deny'}
            onChange={event => setOverrides(values => [...values.filter(value => value.permission !== item.code),
              ...(event.target.value === 'inherit' ? [] : [{ permission: item.code, allowed: event.target.value === 'allow' }])])}
            className="block rounded-lg border px-3 py-2">
            <option value="inherit">Eredita</option><option value="allow">Consenti</option><option value="deny">Nega</option>
          </select></label>
          <Badge tone={control.effective.allowed ? 'green' : 'gray'}>Effettivo: {control.effective.allowed ? 'consentito' : 'negato'}</Badge>
        </div>;
      })}
    </div></Card>)}
  </div>;
}
