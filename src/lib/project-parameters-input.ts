import { z } from 'zod';

export const projectExpenseCategories = ['attrezzature', 'macchinari', 'mezzi', 'ristrutturazione', 'opere_edili', 'impianti', 'software', 'hardware', 'marketing', 'formazione', 'consulenze', 'liquidita', 'acquisto_immobile', 'affitto', 'personale', 'merce', 'eventi', 'spese_legali', 'altro'] as const;
export const projectParameterMoney = z.string().trim().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/, 'Importo non negativo, al massimo due decimali');
export const projectParametersSchema = z.object({
  description: z.string().trim().max(10000),
  totalInvestment: z.union([projectParameterMoney, z.literal('')]),
  requestedAmount: z.union([projectParameterMoney, z.literal('')]),
  expenseVersion: z.string().regex(/^[a-f0-9]{64}$/),
  expenses: z.array(z.object({
    id: z.string().min(1).max(128).nullable(),
    category: z.enum(projectExpenseCategories), description: z.string().trim().min(1).max(500),
    amount: projectParameterMoney, estimated: z.boolean(),
  }).strict()).max(100),
}).strict().superRefine((value, ctx) => {
  const ids = value.expenses.flatMap(row => row.id ? [row.id] : []);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Spesa ripetuta' });
});
export type ProjectParameters = z.infer<typeof projectParametersSchema>;
