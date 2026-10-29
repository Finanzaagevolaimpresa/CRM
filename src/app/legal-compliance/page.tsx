import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import { requirePermission, hasPermission } from '@/lib/auth';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const session = await requirePermission('legal.read');
  const paths = [
    { permission: 'contract.read' as const, title: 'Contratti e firme', href: '/legal-compliance/contracts', text: 'Consulta e correggi i contratti nei loro fascicoli, conservando firme, allegati e pagamenti.' },
    { permission: 'practice_communications.read' as const, title: 'Reclami e contestazioni', href: '/legal-compliance/disputes', text: 'Apri i reclami riservati e il percorso di revisione e comunicazione manuale.' },
    { permission: 'privacy.evidence.read' as const, title: 'Informative e prove privacy', href: '/legal-compliance/privacy', text: 'Consulta versioni delle informative ed evidenze conservate nel registro.' },
    { permission: 'ai.review' as const, title: 'Revisione dei contenuti', href: '/ai/outputs-to-review', text: 'Rivedi le bozze e conserva il percorso di approvazione umana.' },
  ].filter(item => hasPermission(session, item.permission) && (item.href !== '/legal-compliance/disputes' || session.role === 'admin'));
  return <div className="crm-space-y-6"><PageHeader title="Legale e compliance" description="Percorsi operativi e prove conservate nei rispettivi fascicoli." />
    <div className="grid gap-5 md:grid-cols-2">{paths.map(item => <Card key={item.href} title={item.title}><p>{item.text}</p><Link className="mt-4 inline-block font-semibold underline" href={item.href}>Apri {item.title.toLowerCase()}</Link></Card>)}</div>
  </div>;
}
