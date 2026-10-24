import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { parseTechnicalUploadTarget } from '@/lib/technical-upload-display';
import { technicalAssignmentReference } from '@/lib/technical-assignment-decision';
import { readTechnicalUploadForAdmin } from '@/lib/technical-upload-review-service';
import { technicalUploadFileResponse, technicalUploadNotFound } from '@/lib/technical-upload-response';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ kind: string; id: string; recipientId: string; commandId: string }> }) {
  const session = await requireSession(), p = await params, target = parseTechnicalUploadTarget(p);
  if (!target.success) return technicalUploadNotFound();
  const ref = technicalAssignmentReference.safeParse({ ...target.data, recipientId: p.recipientId });
  if (!ref.success) return technicalUploadNotFound();
  try { return technicalUploadFileResponse(await readTechnicalUploadForAdmin(prisma, session, ref.data, p.commandId), new URL(request.url).searchParams.get('download') === '1'); }
  catch { return technicalUploadNotFound(); }
}
