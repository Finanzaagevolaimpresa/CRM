import { z } from 'zod';

export const leadLifecycleReasons = {
  NOT_RELEVANT: 'Non pertinente',
  DUPLICATE: 'Duplicato da conservare nello storico',
  ENTERED_BY_MISTAKE: 'Inserito per errore',
  OTHER: 'Altro',
} as const;
export const leadLifecycleSchema = z.object({
  id: z.string().min(1).max(128),
  updatedAt: z.string().datetime(),
  action: z.enum(['trash', 'restore']),
  confirmed: z.literal('yes'),
  reasonCode: z.enum(['', 'NOT_RELEVANT', 'DUPLICATE', 'ENTERED_BY_MISTAKE', 'OTHER']).default(''),
}).strict();
export type LeadLifecycleAction = z.infer<typeof leadLifecycleSchema>['action'];
export const leadLifecycleCopy = {
  trash: {
    label: 'Sposta nel cestino',
    consequence: 'Il lead esce da pipeline, ricerche e code operative. I collegamenti, le offerte, i documenti, le richieste del sito e lo storico restano conservati; le operazioni che dipendono dal lead vengono sospese. Un cliente già convertito resta disponibile con i suoi diritti attuali. Questa azione non registra una prima risposta e non azzera le scadenze.',
  },
  restore: {
    label: 'Ripristina lead',
    consequence: 'Il lead torna disponibile con stato commerciale e assegnazioni conservati. Le scadenze originali continuano a valere, anche se già superate. Concessioni, consensi e approvazioni email non vengono rinnovati; le richieste rimaste aperte vanno ricaricate.',
  },
} as const;
export function leadLifecycleActionAllowed(deletedAt: Date | null, action: LeadLifecycleAction) {
  return action === 'trash' ? deletedAt === null : deletedAt !== null;
}
