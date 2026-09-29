'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { saveRecordProfile } from './record-profiles';
import { RecordProfileError } from './record-profile-contract';
import { clientProfileFields, companyProfileFields, leadProfileFields, personProfileFields } from './record-profile-fields';

export type ProfileFormState = { error: string | null };
export async function saveRecordProfileAction(_previous: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const session = await requireSession();
  const kind = String(form.get('kind') ?? '');
  const fields = kind === 'lead' ? leadProfileFields : kind === 'client' ? clientProfileFields : kind.endsWith('company') ? companyProfileFields : personProfileFields;
  const data = Object.fromEntries(fields.map(field => [field.name, form.get(field.name) ?? '']));
  if (kind === 'client') data.type = form.get('type') ?? '';
  const command = { kind, id: form.get('id'), data,
    ...(kind === 'new-company' ? { clientId: form.get('clientId') } : {}),
    ...(kind === 'new-person' || kind === 'person' ? { companyId: form.get('companyId') } : {}),
    ...(!kind.startsWith('new-') ? { expectedVersion: form.get('expectedVersion') } : {}),
  };
  let destination: string;
  try { destination = await saveRecordProfile(prisma, session, command); }
  catch (error) {
    if (error instanceof ZodError) return { error: 'Controlla i campi obbligatori, gli indirizzi email, le date e i valori numerici. I dati inseriti sono ancora nel modulo.' };
    if (error instanceof RecordProfileError) return { error: error.code === 'STALE'
      ? 'Questa scheda è stata modificata nel frattempo. Ricarica la pagina prima di salvare per non sovrascrivere le modifiche.'
      : error.code === 'SHARED_PERSON' ? 'Questo referente è collegato a più aziende: la modifica condivisa richiede una gestione dedicata.'
        : error.code === 'DUPLICATE_LEAD' ? 'Esiste già un lead attivo con la stessa email o lo stesso telefono internazionale. Verifica i contatti o richiedi il controllo all’amministratore.'
        : 'Salvataggio non autorizzato: verifica l’assegnazione e i permessi attuali.' };
    throw error;
  }
  revalidatePath('/leads'); revalidatePath('/clients'); revalidatePath('/companies');
  revalidatePath(destination.split('#')[0]);
  redirect(destination);
}
