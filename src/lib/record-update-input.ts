import { z } from 'zod';
import { recordUpdateEvents, recordUpdateKinds, recordUpdateModes } from './record-update-labels';

const date = z.union([z.string().datetime(), z.literal('')]);
export const updatePatchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('LEAD'), nextActionDate: date, nextActionNote: z.string().trim().max(2000) }).strict(),
  z.object({ kind: z.literal('CLIENT'), displayName: z.string().trim().min(1).max(200),
    type: z.enum(['persona_fisica', 'ditta_individuale', 'societa', 'professionista', 'soggetto_da_costituire', 'associazione', 'altro']) }).strict(),
  z.object({ kind: z.literal('PROJECT'), title: z.string().trim().min(1).max(200),
    status: z.enum(['idea', 'raccolta_dati', 'in_analisi', 'preanalisi_pronta', 'dossier_pronto', 'contratto_in_attesa', 'pratica_attiva', 'chiuso']) }).strict(),
  z.object({ kind: z.literal('PRACTICE'), status: z.enum(['da_progettare', 'in_progettazione', 'documenti_richiesti', 'documenti_completi', 'pronta_presentazione', 'presentata', 'in_istruttoria', 'integrazione_richiesta', 'approvata', 'respinta']),
    clientVisibleStatus: z.string().trim().max(500), dueDate: date, nextClientUpdateAt: date }).strict(),
]);
export const updateCommandSchema = z.object({
  mode: z.enum(recordUpdateModes).optional(),
  commandId: z.string().uuid(), kind: z.enum(recordUpdateKinds), recordId: z.string().min(1).max(128),
  operation: z.enum(['UPDATE', 'RULE', 'REVOKE']), expectedVersion: z.string().datetime(),
  ruleVersion: z.number().int().min(0), selection: z.object({ people: z.array(z.string()).max(20), groups: z.array(z.string()).max(5) }).strict(),
  events: z.array(z.enum(recordUpdateEvents)).min(1).max(5), persistent: z.boolean(),
  expiresAt: z.string().datetime().nullable(), patch: updatePatchSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'PROJECT' && value.mode && value.mode !== 'CRM')
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Il progetto dispone del canale CRM' });
  if ((value.operation === 'UPDATE') !== Boolean(value.patch) || (value.patch && value.patch.kind !== value.kind))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Patch e contesto incoerenti' });
  if (value.operation !== 'UPDATE' && value.persistent) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Opzione non pertinente' });
});
export type UpdateCommand = z.infer<typeof updateCommandSchema>;
export type UpdatePatch = z.infer<typeof updatePatchSchema>;
export const updateFieldLabels: Record<string, string> = {
  status: 'Stato', clientVisibleStatus: 'Avanzamento visibile', nextActionDate: 'Prossima azione: data',
  nextActionNote: 'Prossima azione: descrizione', dueDate: 'Scadenza', nextClientUpdateAt: 'Prossimo aggiornamento',
  displayName: 'Denominazione', title: 'Titolo', type: 'Tipo cliente',
};
