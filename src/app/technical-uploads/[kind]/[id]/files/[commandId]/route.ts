import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { parseTechnicalUploadTarget } from '@/lib/technical-upload-display';
import { readOwnTechnicalUpload } from '@/lib/technical-upload-service';
import { technicalUploadFileResponse, technicalUploadNotFound } from '@/lib/technical-upload-response';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ kind: string; id: string; commandId: string }> }) {
  const session = await requireSession(), p = await params, target = parseTechnicalUploadTarget(p);
  if (!target.success) return technicalUploadNotFound();
  try { return technicalUploadFileResponse(await readOwnTechnicalUpload(prisma, session, target.data, p.commandId), new URL(request.url).searchParams.get('download') === '1'); }
  catch { return technicalUploadNotFound(); }
}
