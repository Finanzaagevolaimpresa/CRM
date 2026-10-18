import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readVideoPreview, VideoLibraryError } from '@/lib/video-library';
import { RecordUpdateError } from '@/lib/record-update-contract';
import { PrivateVideoPlayer } from '@/components/private-video-player';
import { loadActivePrivilegedStepUpKey } from '@/lib/application-key-registry';
import { privilegedStepUpCookieName } from '@/lib/privileged-access';
export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ as?: string }> }) {
  const session = await requireSession(), { id } = await params, { as } = await searchParams;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const key = await loadActivePrivilegedStepUpKey(prisma), store = await cookies();
  if (!key) notFound();
  let result;
  try { result = await readVideoPreview(prisma, session, id, { key,
    sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
    stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' }, as); }
  catch (error) { if (error instanceof VideoLibraryError || error instanceof RecordUpdateError) notFound(); throw error; }
  return <div className="crm-space-y-6 min-w-0"><Link className="font-bold underline" href={'/videos/manage/' + id}>← Gestione del video</Link>
    <p className="rounded-xl border p-4">{result.recipientName ? 'Anteprima con i permessi correnti di ' + result.recipientName : 'Anteprima amministrativa privata'}</p>
    {result.allowed ? <PrivateVideoPlayer video={{ ...result.video, mimeType: result.video.mimeType as 'video/mp4' | 'video/webm' }}
      adminPreview asRecipient={as}/> : <p role="status" className="rounded-xl border p-4">La persona non può vedere questo video con i permessi e la pubblicazione correnti. Nessun accesso è stato concesso.</p>}
  </div>;
}
