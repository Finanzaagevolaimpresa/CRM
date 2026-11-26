import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readOperationalDocument } from '@/lib/operational-documents';
import { canUseOperationalDocuments, documentKindLabels } from '@/lib/operational-document-contract';
import { renderOperationalPdf } from '@/lib/operational-document-pdf';
import { assertTechnicalFileRoute } from '@/lib/technical-server-guards';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await assertTechnicalFileRoute('/document-library/[id]/pdf');
  const session = await getSession();
  if (!session || !canUseOperationalDocuments(session)) return new Response('Non disponibile', { status: 404 });
  const { id } = await params;
  try {
    const { row, snapshot, decision } = await readOperationalDocument(prisma, session, id);
    const bytes = renderOperationalPdf({ title: documentKindLabels[row.kind as keyof typeof documentKindLabels] ?? snapshot.templateTitle,
      content: row.content, reference: row.id, status: row.kind === 'PROFORMA' ? 'Documento non fiscale · invio non eseguito'
        : decision ? 'Contenuto confermato · firma non attestata' : 'Bozza · da verificare' });
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${row.id}.pdf"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  } catch { return new Response('Documento non disponibile o PDF non generabile. Verifica la scheda.', { status: 404, headers: { 'Cache-Control': 'no-store' } }); }
}
