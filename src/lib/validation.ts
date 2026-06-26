import { z } from 'zod';
export const leadSchema = z.object({ firstName: z.string().min(1), lastName: z.string().min(1), phone: z.string().optional(), email: z.string().email().optional(), interest: z.string().optional() });
export const clientSchema = z.object({ type: z.string().min(1), displayName: z.string().min(1), notes: z.string().optional() });
export const projectSchema = z.object({ clientId: z.string().min(1), title: z.string().min(1), description: z.string().optional(), totalInvestment: z.coerce.number().optional() });
export const documentSchema = z.object({ title: z.string().min(1), type: z.string().min(1), fileName: z.string().min(1), mimeType: z.string().min(1), sizeBytes: z.coerce.number(), storagePath: z.string().min(1) });
export const preAnalysisSchema = z.object({ projectId: z.string().min(1), clientId: z.string().min(1), internalSummary: z.string().optional() });
