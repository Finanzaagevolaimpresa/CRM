import { cookies } from 'next/headers';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readVideoBytes, VideoLibraryError } from '@/lib/video-library';
import { privateVideoResponse } from '@/lib/video-response';
import { loadActivePrivilegedStepUpKey } from '@/lib/application-key-registry';
import { privilegedStepUpCookieName } from '@/lib/privileged-access';
import { RecordUpdateError } from '@/lib/record-update-contract';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
async function response(request: Request, context: { params: Promise<{ id: string }> }) {
  return privateVideoResponse(request, async download => {
    const session = await getSession(), { id } = await context.params;
    if (!session || !z.string().uuid().safeParse(id).success) return null;
    const url = new URL(request.url), preview = url.searchParams.get('preview') === '1', asRecipient = url.searchParams.get('as') ?? undefined;
    let proof;
    if (preview || asRecipient) {
      const key = await loadActivePrivilegedStepUpKey(prisma), store = await cookies();
      if (!key) return null;
      proof = { key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
        stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' };
    }
    try { return await readVideoBytes(prisma, session, id, { download, preview, asRecipient, proof }); }
    catch (error) { if (error instanceof VideoLibraryError || error instanceof RecordUpdateError || error instanceof z.ZodError) return null; throw error; }
  });
}
export const GET = response;
export const HEAD = response;
