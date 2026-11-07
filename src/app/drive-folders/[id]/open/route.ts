import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readDriveFolder } from '@/lib/drive-folder-library';
import { assertTechnicalFileRoute } from '@/lib/technical-server-guards';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Cookie' };
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await assertTechnicalFileRoute('/drive-folders/[id]/open');
  try {
    const session = await requireSession(), { id } = await params, row = await readDriveFolder(prisma, session, id);
    // Local admission check only. No server request to Google and no file proxy.
    return new Response(null, { status: 302, headers: { ...headers, Location: row.url } });
  } catch { return new Response(null, { status: 404, headers }); }
}
export const HEAD = GET;
