import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readPersonalAcquiredDocument } from '@/lib/technical-document-acquired-access';
import { technicalUploadFileResponse, technicalUploadNotFound } from '@/lib/technical-upload-response';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(), { id } = await params;
  const query = new URL(request.url).searchParams;
  try { return technicalUploadFileResponse(await readPersonalAcquiredDocument(prisma, session, id, query.get('version')), query.get('download') === '1'); }
  catch { return technicalUploadNotFound(); }
}
