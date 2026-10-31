'use client';
import { useState } from 'react';
import Link from 'next/link';
import { AdminUserForm } from './admin-user-form';
import type { AdminUserCommandIdentity } from '@/lib/admin-user-command-contract';
export type CreationRoleProfile = { role: string; version: string; revision: number; labels: string[] };
export function AdminCreationRoleSelector({ profiles: initial }: { profiles: CreationRoleProfile[] }) {
  const [profiles] = useState(initial);
  const [role, setRole] = useState('collaboratore_limitato');
  const profile = profiles.find(value => value.role === role)!;
  return <div className="md:col-span-5 space-y-3">
    <label>Ruolo<select className="block rounded-xl border p-3" name="role" value={role} onChange={event => setRole(event.target.value)}>
      {profiles.map(value => <option key={value.role} value={value.role}>{value.role}</option>)}
    </select></label>
    <input type="hidden" name="roleProfileVersion" value={profile.version}/>
    <p>Profilo selezionato · revisione {profile.revision}: {profile.labels.join(', ') || 'Nessuna funzione consentita'}.</p>
    <p>Le autorizzazioni specifiche su clienti, progetti, pratiche e versioni documentali si concedono nei rispettivi contesti.</p>
  </div>;
}
export function AdminRoleProfileApplication(props: { identity: AdminUserCommandIdentity; profile: CreationRoleProfile; name: string; email: string }) {
  const [{ identity, profile, name, email }] = useState(props);
  return <div className="space-y-3"><p>{name} · {email} · {profile.role}. Profilo revisione {profile.revision}.</p>
    <p>Permessi consentiti: {profile.labels.join(', ') || 'Nessuno'}.</p>
    <p>Sostituisce le eccezioni individuali di questo account. Concessioni, responsabilità e azioni personali restano invariate.</p>
    <AdminUserForm identity={identity} label="Applica profilo del ruolo">
      <input type="hidden" name="roleProfileVersion" value={profile.version}/>
      <label><input type="checkbox" name="confirmed" required/> Confermo questa versione e la sostituzione delle eccezioni individuali.</label>
      <button className="block rounded-xl border p-3">Applica profilo a questo account</button>
    </AdminUserForm><Link className="underline" href={'/settings/roles/' + profile.role}>Modifica il profilo del ruolo</Link>
  </div>;
}
