export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { Badge, Card, PageHeader, Table } from '@/components/ui';
import { permissionCodes, requirePermission, rolePermissions } from '@/lib/auth';

const roleDescriptions: Record<string, string> = {
  admin: 'Accesso completo a CRM, settings, utenti, ruoli, audit, documenti anche sensibili e funzioni operative.',
  direzione: 'Vista direzionale completa su dati operativi, documenti sensibili, AI, dossier, contratti, pagamenti e audit.',
  commerciale: 'Lavora lead e clienti assegnati, con visibilità operativa limitata a progetti e servizi collegati.',
  consulente: 'Gestisce progetti e servizi assegnati, upload/download documenti consentiti, richieste AI e dossier operativi.',
  revisore: 'Revisiona output AI e dossier senza rilasciarli, consulta documenti necessari inclusi sensibili dove autorizzato.',
  backoffice: 'Gestisce task, servizi operativi e documenti non sensibili secondo assegnazioni e permessi.',
  amministrazione: 'Consulta e gestisce contratti, pagamenti e documenti amministrativi autorizzati.',
  collaboratore_limitato: 'Vede solo elementi assegnati e documenti non sensibili autorizzati; nessun accesso settings/audit.',
};

const visiblePermissionCodes = permissionCodes.filter((permission) => permission !== 'ai.execution.consume');

function describePermissions(perms: readonly string[]) {
  const effective = perms.includes('*') ? ['*', ...visiblePermissionCodes.filter((permission) => !perms.includes(permission))] : perms;
  return effective.map((permission) => permission === '*' ? 'Tutti i permessi' : permission.replaceAll('.', ' → ')).join(', ');
}

function hasDossierWrite(perms: readonly string[]) { return perms.includes('*') || perms.includes('dossier.write'); }
function hasDossierRead(perms: readonly string[]) { return perms.includes('*') || perms.includes('dossier.read'); }

export default async function Page() {
  const session = await requirePermission('settings.manage');

  const rows = Object.entries(rolePermissions).map(([role, perms]) => [
    <Badge key="role" tone={role === 'admin' ? 'green' : role === 'direzione' ? 'purple' : 'blue'}>{role}</Badge>,
    <span key="description">{roleDescriptions[role] ?? 'Ruolo interno configurato nel sistema.'}<br/><Link className="font-bold underline" href={`/settings/users?role=${encodeURIComponent(role)}`}>Scegli un account di questo ruolo e gestisci i permessi</Link>{session.role === 'admin' && role !== 'admin' && <><br/><Link className="font-bold underline" href={'/settings/roles/' + role}>Modifica il profilo per i nuovi account</Link></>}</span>,
    <span key="dossier" className="block"><span className="font-semibold">Dossier:</span> lettura {hasDossierRead(perms) ? 'abilitata' : 'non abilitata'} · scrittura {hasDossierWrite(perms) ? 'abilitata' : 'non abilitata'}<br />{describePermissions(perms)}</span>,
  ]);

  return (
    <div className="crm-space-y-6">
      <PageHeader
        title="Ruoli e permessi"
        description="Profili del CRM: l’Admin può versionare i permessi per i nuovi account e applicarli esplicitamente a un account esistente. Le concessioni su clienti, progetti e documenti si decidono nel loro contesto."
      />
      <Card title="Matrice operativa ruoli interni">
        <Table headers={['Ruolo', 'Profilo e gestione account', 'Permessi di base']} rows={rows} />
      </Card>
      <Card title="Regole di sicurezza applicate">
        <ul className="list-disc crm-space-y-2 pl-5 text-sm leading-6 text-fai-gray">
          <li>La matrice descrive il profilo di base. Le eccezioni individuali, le assegnazioni e le concessioni possono limitarne l’accesso: consulta l’account identificato anche dall’email per vedere e cambiare le sue impostazioni.</li>
          <li>Le pagine settings e audit sono protette server-side con permessi dedicati.</li>
          <li>Admin e direzione possono consultare utenti, ruoli, audit log e gestire le bozze dossier/pre-analisi e la configurazione degli agenti AI interni.</li>
          <li>Ogni ruolo può soltanto richiedere l&apos;uso dell&apos;AI nel proprio perimetro; approvazione, rifiuto, revoca e audit completo sono riservati all&apos;Admin.</li>
          <li>Il consumo monouso di un grant AI è un&apos;operazione tecnica interna e non viene esposto come permesso interattivo, nemmeno all&apos;Admin.</li>
          <li>Gli altri ruoli non vedono i link in sidebar e, se aprono la rotta diretta, vengono reindirizzati.</li>
          <li>I permessi documentali restano invariati: i percorsi privati di storage non vengono esposti.</li>
        </ul>
      </Card>
    </div>
  );
}
