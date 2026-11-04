import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readDriveVideo } from '@/lib/drive-video-library';
import { assertTechnicalFileRoute } from '@/lib/technical-server-guards';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await assertTechnicalFileRoute('/videos/drive/[id]/access');
  try {
    const session = await requireSession(), { id } = await params, row = await readDriveVideo(prisma, session, id);
    return Response.json({ version: row.version }, { headers });
  } catch { return new Response(null, { status: 404, headers }); }
}
