'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { ProjectLifecycleError, transitionProjectLifecycle } from './project-lifecycle';
import { ZodError } from 'zod';

export async function changeProjectLifecycle(_previous: { ok: boolean; message: string }, form: FormData) {
  const session = await requireSession();
  let destination: string;
  try {
    const result = await transitionProjectLifecycle(prisma, session, Object.fromEntries(
      ['id', 'updatedAt', 'action', 'confirmed'].map(key => [key, form.get(key)])));
    revalidatePath('/projects');
    revalidatePath(`/projects/${result.id}`);
    revalidatePath('/dashboard');
    destination = result.state === 'trash' ? '/projects?view=trash' : result.state === 'archived' ? '/projects?view=archive' : `/projects/${result.id}`;
  } catch (error) {
    if (error instanceof ProjectLifecycleError) return { ok: false, message: error.code === 'STALE'
      ? 'Il progetto è cambiato. Ricarica la pagina e verifica nuovamente l’azione.' : 'Operazione non disponibile per il tuo accesso attuale.' };
    if (error instanceof ZodError) return { ok: false, message: 'Conferma le conseguenze prima di procedere.' };
    return { ok: false, message: 'Esito non confermato. Ricarica la pagina e verifica lo stato prima di riprovare.' };
  }
  redirect(destination);
}
