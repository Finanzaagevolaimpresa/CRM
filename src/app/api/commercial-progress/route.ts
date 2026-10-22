import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { CommercialProgressUnavailable, readCommercialProgress } from '@/lib/commercial-progress';
import { SerializableConflictError } from '@/lib/serializable';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Sessione richiesta' }, { status: 401, headers });
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['client', 'q', 'after'].includes(key) || params.getAll(key).length !== 1)) {
      return Response.json({ error: 'Filtri non validi' }, { status: 400, headers });
    }
    const result = await readCommercialProgress(prisma, session, Object.fromEntries(params));
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof CommercialProgressUnavailable) return Response.json({ error: 'Avanzamento non disponibile' }, { status: 403, headers });
    if (error instanceof z.ZodError) return Response.json({ error: 'Filtri non validi' }, { status: 400, headers });
    if (error instanceof SerializableConflictError) return Response.json({ error: 'Dati aggiornati durante la consultazione. Riprova.' }, { status: 409, headers });
    throw error;
  }
}
