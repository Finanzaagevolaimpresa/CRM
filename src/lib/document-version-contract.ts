import { z } from 'zod';
export const documentVersionCommandSchema = z.object({
  documentId: z.string().min(1).max(128), requestId: z.string().uuid(),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true),
}).strict();
export type DocumentVersionCommand = z.infer<typeof documentVersionCommandSchema>;
export type DocumentVersionResult = { ok: true; version: number; versionId: string; replay: boolean }
  | { ok: false; code: 'DENIED' | 'STALE' | 'INVALID' | 'UNKNOWN' | 'NOT_OBSERVED'; message: string };
export class DocumentVersionError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'INVALID') { super(code); }
}
export function versionErrorResult(code: DocumentVersionError['code']): DocumentVersionResult {
  return { ok: false, code, message: code === 'DENIED' ? 'Documento non disponibile per questa operazione.'
    : code === 'STALE' ? 'Il documento è cambiato. Ricarica e verifica la versione corrente prima di preparare una nuova richiesta.'
    : 'Controlla file, formato e conferma. Nome, formato e collegamenti del documento restano invariati.' };
}
