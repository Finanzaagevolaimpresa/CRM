export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Badge, Card, EmptyState, PageHeader, Table, formatDateTime } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export default async function Page() {
  await requirePermission('privacy.evidence.read');
  const [notices, evidence] = await Promise.all([
    prisma.privacyNoticeVersion.findMany({
      orderBy: [{ noticeCode: 'asc' }, { noticeVersion: 'desc' }],
      take: 100,
      select: { id: true, noticeCode: true, noticeVersion: true, purposeCode: true, legalBasisCode: true, evidenceKind: true, contentHash: true, status: true, effectiveFrom: true, retiredAt: true },
    }),
    prisma.privacyEvidenceReceipt.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, purposeCode: true, legalBasisCode: true, evidenceKind: true, decision: true, sourceSystem: true, formCode: true, formVersion: true, catalogVersion: true, createdAt: true, noticeVersion: { select: { noticeCode: true, noticeVersion: true } } },
    }),
  ]);

  return <div className="space-y-6">
    <PageHeader title="Privacy e consensi" description="Registro interno minimizzato e in sola lettura. Le versioni devono essere validate prima dell’attivazione dei canali di acquisizione." />
    <Card title="Versioni informative">
      {notices.length === 0 ? <EmptyState title="Nessuna informativa registrata">La fondazione resta fail-closed finché una versione validata non viene registrata con finalità, base giuridica e hash espliciti.</EmptyState> : <Table
        headers={['Codice / versione', 'Finalità', 'Base giuridica', 'Tipo', 'Hash contenuto', 'Stato', 'Decorrenza']}
        rows={notices.map((notice) => [
          <span key={notice.id}>{notice.noticeCode}<br /><span className="text-xs text-slate-500">{notice.noticeVersion}</span></span>,
          notice.purposeCode,
          notice.legalBasisCode,
          notice.evidenceKind,
          <span key="hash" className="font-mono text-xs">{notice.contentHash}</span>,
          <Badge key="status" tone={notice.status === 'ACTIVE' ? 'green' : 'blue'}>{notice.status}</Badge>,
          notice.effectiveFrom ? formatDateTime(notice.effectiveFrom) : '—',
        ])}
      />}
    </Card>
    <Card title="Evidenze minimizzate">
      {evidence.length === 0 ? <EmptyState title="Nessuna evidenza acquisita">Non risultano ricevute privacy o marketing. La vista non mostra contatti, IP, testo libero o dati del lead.</EmptyState> : <Table
        headers={['Data', 'Finalità', 'Decisione', 'Informativa', 'Origine form', 'Catalogo']}
        rows={evidence.map((receipt) => [
          formatDateTime(receipt.createdAt),
          <span key={receipt.id}>{receipt.purposeCode}<br /><span className="text-xs text-slate-500">{receipt.legalBasisCode}</span></span>,
          <Badge key="decision" tone={receipt.decision === 'GRANTED' || receipt.decision === 'ACKNOWLEDGED' ? 'green' : 'blue'}>{receipt.decision}</Badge>,
          `${receipt.noticeVersion.noticeCode} · ${receipt.noticeVersion.noticeVersion}`,
          `${receipt.sourceSystem} · ${receipt.formCode}/${receipt.formVersion}`,
          receipt.catalogVersion,
        ])}
      />}
    </Card>
    <SecondaryLink href="/legal-compliance">Vai a Legale / Compliance</SecondaryLink>
  </div>;
}
