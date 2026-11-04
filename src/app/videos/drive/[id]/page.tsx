import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readDriveVideo } from '@/lib/drive-video-library';
import { DriveVideoPlayer } from '@/components/drive-video-player';
import { PageHeader } from '@/components/ui';
export const dynamic = 'force-dynamic';
async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, session = await requireSession();
  const row = await readDriveVideo(prisma, session, id).catch(() => notFound());
  return <div className="space-y-6 min-w-0"><PageHeader title={row.title} description={row.description}/>
    <Link className="font-bold underline" href="/videos">← Video</Link>
    <DriveVideoPlayer id={id} version={row.version} url={row.url} expiresAt={row.expiresAt}/>
  </div>;
}
export default withTechnicalPage('/videos/drive/[id]', Page);
