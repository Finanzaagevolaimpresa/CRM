import Link from 'next/link';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listOperationalTemplates } from '@/lib/operational-documents';
import { documentKindLabels } from '@/lib/operational-document-contract';
import { Card, PageHeader } from '@/components/ui';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
export const dynamic = 'force-dynamic';
async function Page() {
  const session = await requireSession(), rows = await listOperationalTemplates(prisma, session, true);
  return <div className="crm-space-y-6"><PageHeader title="Modelli" description="Le pubblicazioni conservano la propria versione. Ogni utilizzo genera una nuova bozza del cliente."/>
    <Link className="font-bold underline" href="/document-library/templates/new">Nuovo modello</Link>
    <Card title="Libreria">{rows.length ? <ul className="space-y-4">{rows.map(row => <li key={row.id} className="rounded-xl border p-4">
      <Link className="font-bold underline" href={'/document-library/templates/' + row.id}>{row.title}</Link> · {documentKindLabels[row.kind]} · v{row.revision} · {row.state === 'PUBLISHED' ? 'Pubblicato' : 'Bozza'}
      <Link className="ml-4 underline" href={'/document-library/templates/new?duplicate=' + row.id}>Duplica</Link></li>)}</ul> : <p>Nessun modello creato.</p>}</Card>
    <Link className="font-bold underline" href="/document-library">Documenti e Contratti</Link>
  </div>;
}
export default withTechnicalPage('/document-library/templates', Page);
