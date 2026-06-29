export const dynamic = 'force-dynamic';

import { Badge, Card, EmptyState, PageHeader, Table, formatDateTime } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const eventLabels: Record<string, string> = {
  login: 'Login',
  logout: 'Logout',
  document_upload: 'Upload documento',
  document_download: 'Download documento',
  document_sensitive_access: 'Accesso documento sensibile',
  user_create: 'Modifica utente',
  user_deactivate: 'Modifica utente',
  role_change: 'Modifica ruolo',
  user_role_change: 'Modifica ruolo',
  client_service_status_change: 'Cambio stato task/servizio',
  task_complete: 'Cambio stato task/servizio',
  contract_modify: 'Modifica contratto/pagamento',
  payment_register: 'Modifica contratto/pagamento',
};

function summarizePayload(value: unknown) {
  if (!value) return '—';

  const text = JSON.stringify(value, (key, val) => {
    if (key === 'storagePath') return '[omesso]';
    return val;
  });

  if (!text) return '—';
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

export default async function Page() {
  await requirePermission('audit.read');

  const [logs, users] = await Promise.all([
    prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        actorId: true,
        event: true,
        entityType: true,
        entityId: true,
        before: true,
        after: true,
        ipAddress: true,
        createdAt: true,
      },
    }),
    prisma.user.findMany({ select: { id: true, name: true, email: true, role: true } }),
  ]);

  const userById = new Map(users.map((user) => [user.id, user]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Registro interno degli eventi già tracciati dal CRM FAI: accessi, documenti, utenti, ruoli e variazioni operative. La pagina usa il modello AuditLog esistente e non espone percorsi di storage privati."
      />

      <Card title="Eventi monitorati">
        <div className="grid gap-3 text-sm text-fai-gray md:grid-cols-2 xl:grid-cols-3">
          {Object.entries(eventLabels).map(([event, label]) => (
            <div key={event} className="rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-200">
              <Badge tone="purple">{event}</Badge>
              <p className="mt-2 font-semibold text-fai-navy">{label}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Ultimi eventi">
        {logs.length === 0 ? (
          <EmptyState title="Nessun evento audit presente">
            Il modello AuditLog esiste già nel database, ma non sono ancora presenti eventi da mostrare.
          </EmptyState>
        ) : (
          <Table
            headers={['Data', 'Evento', 'Attore', 'Entità', 'IP', 'Dettagli']}
            rows={logs.map((log) => {
              const actor = log.actorId ? userById.get(log.actorId) : null;
              return [
                formatDateTime(log.createdAt),
                <div className="space-y-1" key="event">
                  <Badge tone={eventLabels[log.event] ? 'green' : 'blue'}>{log.event}</Badge>
                  <p className="text-xs font-semibold text-slate-500">{eventLabels[log.event] ?? 'Evento operativo'}</p>
                </div>,
                actor ? `${actor.name} (${actor.email}) · ${actor.role}` : log.actorId ? `Utente non trovato (${log.actorId})` : 'Sistema',
                <span key="entity">{log.entityType ?? '—'}<br /><span className="text-xs text-slate-500">{log.entityId ?? '—'}</span></span>,
                log.ipAddress ?? '—',
                <div className="max-w-md space-y-1 text-xs leading-5" key="details">
                  <p><span className="font-black text-slate-600">Before:</span> {summarizePayload(log.before)}</p>
                  <p><span className="font-black text-slate-600">After:</span> {summarizePayload(log.after)}</p>
                </div>,
              ];
            })}
          />
        )}
      </Card>
    </div>
  );
}
