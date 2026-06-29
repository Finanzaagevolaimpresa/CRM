export const dynamic = 'force-dynamic';

import { Badge, Card, PageHeader, Table } from '@/components/ui';
import { requirePermission, rolePermissions } from '@/lib/auth';

const roleDescriptions: Record<string, string> = {
  admin: 'Accesso completo a CRM, settings, utenti, ruoli, audit, documenti anche sensibili e funzioni operative.',
  direzione: 'Vista direzionale completa su dati operativi, documenti sensibili, AI, dossier, contratti, pagamenti e audit.',
  commerciale: 'Lavora lead e clienti assegnati, con visibilità operativa limitata a progetti e servizi collegati.',
  consulente: 'Gestisce progetti e servizi assegnati, upload/download documenti consentiti, AI in bozza e dossier operativi.',
  revisore: 'Revisiona output AI e dossier, consulta documenti necessari inclusi sensibili dove autorizzato.',
  backoffice: 'Gestisce task, servizi operativi e documenti non sensibili secondo assegnazioni e permessi.',
  amministrazione: 'Consulta e gestisce contratti, pagamenti e documenti amministrativi autorizzati.',
  collaboratore_limitato: 'Vede solo elementi assegnati e documenti non sensibili autorizzati; nessun accesso settings/audit.',
};

function describePermissions(perms: readonly string[]) {
  if (perms.includes('*')) return 'Tutti i permessi effettivi disponibili nel CRM interno.';
  return perms.map((permission) => permission.replaceAll('.', ' → ')).join(', ');
}

export default async function Page() {
  await requirePermission('settings.manage');

  const rows = Object.entries(rolePermissions).map(([role, perms]) => [
    <Badge key="role" tone={role === 'admin' ? 'green' : role === 'direzione' ? 'purple' : 'blue'}>{role}</Badge>,
    roleDescriptions[role] ?? 'Ruolo interno configurato nel sistema.',
    describePermissions(perms),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ruoli e permessi"
        description="Matrice dei ruoli interni FAI e dei permessi effettivi applicati server-side. Questa sezione non crea area cliente pubblica e non abilita invii automatici."
      />
      <Card title="Matrice operativa ruoli interni">
        <Table headers={['Ruolo', 'Cosa può vedere/fare', 'Permessi effettivi']} rows={rows} />
      </Card>
      <Card title="Regole di sicurezza applicate">
        <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-fai-gray">
          <li>Le pagine settings e audit sono protette server-side con permessi dedicati.</li>
          <li>Admin e direzione possono consultare utenti, ruoli e audit log.</li>
          <li>Gli altri ruoli non vedono i link in sidebar e, se aprono la rotta diretta, vengono reindirizzati.</li>
          <li>I permessi documentali restano invariati: i percorsi privati di storage non vengono esposti.</li>
        </ul>
      </Card>
    </div>
  );
}
