import { AdminUserRecovery } from './admin-user-form';
import { adminUserCommandIdentity } from '@/lib/admin-user-command-contract';
import { Card, PageHeader } from './ui';
export function AdminUserRecoveryPage({ encoded }: { encoded: string }) {
  let input;
  try { input = adminUserCommandIdentity.safeParse(JSON.parse(encoded)); } catch { return <p>Riferimento del comando non valido.</p>; }
  if (!input.success) return <p>Riferimento del comando non valido.</p>;
  return <div className="space-y-6"><PageHeader title="Esito operazione account" description="Verifica il tentativo conservato prima di proseguire." />
    <Card title="Riconciliazione"><AdminUserRecovery identity={input.data} /></Card></div>;
}
