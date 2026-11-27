import { z } from 'zod';
import { resolveRomeDateTime } from './rome-date-time';

export const setterOutcomes = {
  UNREACHABLE: 'Irreperibile', CONTACT: 'Contatto effettivo', VIDEO_BOOKED: 'Videochiamata fissata',
  VIDEO_HELD: 'Svolta', VIDEO_DEFERRED: 'Rinviata', VIDEO_ABSENT: 'Assente',
} as const;
export const setterFields = {
  project: 'Progetto e obiettivo', site: 'Sede del progetto', obstacle: 'Esigenza o ostacolo',
  expenses: 'Spese previste e priorità', timing: 'Tempi di avvio e realizzazione',
  quotes: 'Preventivi e spese già sostenute', investment: 'Investimento totale (€)',
  ownFunds: 'Risorse proprie (€)', financing: 'Importo da finanziare (€)', instalments: 'Rate sostenibili',
  activity: 'Stato dell’attività', otherAid: 'Altri aiuti o domande', consultantSummary: 'Indicazioni per il consulente',
} as const;
export const assistanceOptions = {
  UNKNOWN: 'Da approfondire', INTERESTED: 'Disponibile all’affiancamento', DECLINED: 'Non interessato',
} as const;
export const riskFields = { crif: 'CRIF', central: 'Centrale dei Rischi', delays: 'Ritardi' } as const;
export const riskOrigins = { UNKNOWN: 'Non rilevato', DECLARED: 'Dichiarato', VERIFIED: 'Verificato' } as const;
export function effectiveSetterContact(outcome: keyof typeof setterOutcomes) {
  return outcome === 'CONTACT' || outcome === 'VIDEO_BOOKED' || outcome === 'VIDEO_HELD';
}
const short = z.string().trim().max(1600);
const date = z.string().refine(s => !s || (/^\d{4}-\d{2}-\d{2}$/.test(s) && resolveRomeDateTime(s + 'T12:00').kind === 'unique'), 'Data non valida.');
const evidence = z.object({ origin: z.enum(['UNKNOWN','DECLARED','VERIFIED']), finding: short, source: short, date }).strict()
  .superRefine((item, ctx) => {
    if (item.origin === 'UNKNOWN' && (item.finding || item.source || item.date))
      ctx.addIssue({ code: 'custom', message: 'Indica se il dato è dichiarato o verificato.' });
    if (item.origin !== 'UNKNOWN' && !item.finding)
      ctx.addIssue({ code: 'custom', message: 'Descrivi brevemente il dato rilevato.' });
    if (item.origin === 'VERIFIED' && !item.source && !item.date)
      ctx.addIssue({ code: 'custom', message: 'Per il dato verificato indica la fonte o la data della verifica.' });
  });
export const setterDetails = z.object({
  project: short, site: short, obstacle: short, expenses: short, timing: short, quotes: short,
  investment: short, ownFunds: short, financing: short, instalments: short, activity: short, otherAid: short,
  consultantSummary: short, assistance: z.enum(['UNKNOWN','INTERESTED','DECLINED']),
  crif: evidence, central: evidence, delays: evidence,
}).strict();
export type SetterDetails = z.infer<typeof setterDetails>;
export type SetterOutcome = keyof typeof setterOutcomes;
const outcomes = Object.keys(setterOutcomes) as [SetterOutcome, ...SetterOutcome[]];
const command = z.object({
  id: z.string().uuid(), leadId: z.string().min(1).max(128), version: z.number().int().positive().nullable(), leadVersion: z.string().datetime(),
  outcome: z.enum(outcomes), nextKind: z.enum(['CALLBACK','VIDEO','NONE']),
  nextLocal: z.string().max(19), details: setterDetails.nullable(),
  appointment: z.object({ id: z.string().uuid(), calendarId: z.string().min(1).max(128),
    expectedVersion: z.number().int().min(0), durationMinutes: z.number().int().min(15).max(180) }).strict().optional(),
}).strict();
export type SetterCommand = z.output<typeof command>;
export class SetterInputError extends Error {}
export function prepareSetterCommand(input: unknown) {
  const parsed = command.safeParse(input);
  if (!parsed.success) throw new SetterInputError(parsed.error.issues[0]?.message ?? 'Scheda chiamata non valida.');
  const value = parsed.data;
  if (value.appointment && value.nextKind !== 'VIDEO') throw new SetterInputError('I dati del calendario appartengono alla prenotazione della videochiamata.');
  const video = value.outcome === 'VIDEO_BOOKED' || value.outcome === 'VIDEO_DEFERRED';
  if ((video && value.nextKind !== 'VIDEO') || (value.nextKind === 'VIDEO' && !video)
    || (['UNREACHABLE','VIDEO_ABSENT'].includes(value.outcome) && value.nextKind !== 'CALLBACK'))
    throw new SetterInputError('Abbina all’esito un richiamo oppure la data della videochiamata.');
  if (value.outcome === 'UNREACHABLE' && value.details !== null)
    throw new SetterInputError('Per un tentativo senza risposta registra soltanto esito e richiamo.');
  if ((value.outcome === 'CONTACT' || value.outcome === 'VIDEO_HELD') && !value.details?.consultantSummary)
    throw new SetterInputError('Inserisci il riepilogo per il consulente.');
  if (value.nextKind === 'NONE') {
    if (value.nextLocal) throw new SetterInputError('Verifica la data della prossima azione.');
    return { value, nextAt: null };
  }
  const dayOnly = value.nextLocal.length === 10;
  if (dayOnly && value.nextKind === 'VIDEO') throw new SetterInputError('Indica data e ora della videochiamata.');
  const resolved = resolveRomeDateTime(value.nextLocal + (dayOnly ? 'T00:00' : ''));
  if (resolved.kind !== 'unique') throw new SetterInputError('Scegli una data e un orario univoco nel fuso di Roma.');
  return { value, nextAt: new Date(resolved.instants[0]) };
}
