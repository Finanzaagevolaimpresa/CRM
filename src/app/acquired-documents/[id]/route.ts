import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readPersonalAcquiredDocument } from '@/lib/technical-document-acquired-access';
import { technicalUploadFileResponse, technicalUploadNotFound } from '@/lib/technical-upload-response';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(), { id } = await params;
  try { return technicalUploadFileResponse(await readPersonalAcquiredDocument(prisma, session, id), new URL(request.url).searchParams.get('download') === '1'); }
  catch { return technicalUploadNotFound(); }
}
