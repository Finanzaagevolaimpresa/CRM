import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PageHeader } from '@/components/ui';
import { VideoEditor } from '@/components/video-editor';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readVideoSetup, VideoLibraryError } from '@/lib/video-library';
import { previewVideoAction, confirmVideoAction, verifyVideoAction, searchVideoFilesAction } from '@/lib/video-actions';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(), { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  let setup;
  try { setup = await readVideoSetup(prisma, session, id); }
  catch (error) { if (error instanceof VideoLibraryError) notFound(); throw error; }
  return <div className="crm-space-y-6 min-w-0"><PageHeader title="Gestisci video" description="Le modifiche richiedono una nuova anteprima e una conferma personale."/>
    <Link href="/videos/manage" className="font-bold underline">← Gestione video</Link>
    <VideoEditor setup={setup} actions={{ preview: previewVideoAction, confirm: confirmVideoAction, verify: verifyVideoAction, files: searchVideoFilesAction }}/>
    <section className="space-y-3 rounded-xl border p-4"><h2 className="text-lg font-bold">Anteprima con accesso corrente</h2>
      <p>Le anteprime richiedono la conferma amministrativa personale attiva. La verifica come destinatario applica i suoi permessi correnti.</p>
      <Link className="inline-block font-bold underline" href={'/videos/manage/' + id + '/preview'}>Anteprima del file</Link>
      {setup.state === 'PUBLISHED' && <form action={'/videos/manage/' + id + '/preview'} className="flex flex-wrap gap-3">
        <label className="min-w-0 flex-1 font-bold">Come destinatario<select name="as" required className="mt-1 block w-full rounded-xl border p-3">
          <option value="">Scegli una persona</option>{setup.people.map(p => <option value={p.id} key={p.id}>{p.name} · {p.email} ({p.role})</option>)}</select></label>
        <button className="self-end rounded-xl border px-4 py-3 font-bold">Verifica anteprima</button>
      </form>}
    </section>
  </div>;
}
