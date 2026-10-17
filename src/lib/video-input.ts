import { z } from 'zod';

const personId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const areas = z.enum(['commerciali', 'tecnico', 'amministrazione', 'direzione', 'revisori']);
const command = z.object({ commandId: z.string().uuid(), videoId: z.string().uuid(), expectedVersion: z.number().int().min(0).max(2_147_483_646) });
export const videoDetailsSchema = z.object({
  fileId: z.string().uuid(), title: z.string().trim().min(1).max(160), description: z.string().trim().max(3000),
  category: z.string().trim().max(80), position: z.number().int().min(0).max(10000),
  selection: z.object({ people: z.array(personId).max(100), areas: z.array(areas).max(5) }).strict(),
  downloadAllowed: z.boolean(), expiresAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export const videoCommandSchema = z.discriminatedUnion('operation', [
  command.extend({ operation: z.literal('SAVE_DRAFT'), details: videoDetailsSchema }).strict(),
  command.extend({ operation: z.literal('PUBLISH'), details: videoDetailsSchema }).strict(),
  command.extend({ operation: z.literal('ARCHIVE') }).strict(),
  command.extend({ operation: z.literal('RESTORE_DRAFT') }).strict(),
]);
export type VideoCommand = z.infer<typeof videoCommandSchema>;
export type VideoDetails = z.infer<typeof videoDetailsSchema>;
