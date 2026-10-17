import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readVideo, VideoLibraryError } from '@/lib/video-library';
import { PrivateVideoPlayer } from '@/components/private-video-player';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(), { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  let video;
  try { video = await readVideo(prisma, session, id); }
  catch (error) { if (error instanceof VideoLibraryError) notFound(); throw error; }
  return <div className="crm-space-y-6 min-w-0"><Link className="font-bold underline" href="/videos">← Libreria video</Link>
    <PrivateVideoPlayer video={{ ...video, mimeType: video.mimeType as 'video/mp4' | 'video/webm' }}/></div>;
}
