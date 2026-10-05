export const documentUploadMaxBytes = 25 * 1024 * 1024;
export const documentUploadMaxFiles = 20;
export const documentUploadExtensions = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.odt', '.ods', '.p7m', '.xml', '.zip'] as const;
export type UploadResult = { ok: true } | { ok: false; message: string };
export type UploadProgress = { index: number; result: UploadResult };

export function validateUploadSelection(files: Array<{ name: string; size: number }>): string | null {
  if (!files.length) return 'Seleziona almeno un file.';
  if (files.length > documentUploadMaxFiles) return `Seleziona al massimo ${documentUploadMaxFiles} file per operazione.`;
  for (const file of files) {
    if (!file.size) return `${file.name}: il file è vuoto.`;
    if (file.size > documentUploadMaxBytes) return `${file.name}: il limite è 25 MB per file.`;
    const extension = /\.[^.]+$/.exec(file.name)?.[0].toLowerCase();
    if (!documentUploadExtensions.some(allowed => allowed === extension)) return `${file.name}: formato non consentito.`;
  }
  return null;
}

/** One submission, bounded individual requests; successful files are never retried. */
export async function uploadSelection(files: File[], metadata: FormData, send: (form: FormData) => Promise<UploadResult>, progress: (value: UploadProgress) => void) {
  const invalid = validateUploadSelection(files);
  if (invalid) throw new Error(invalid);
  const title = String(metadata.get('title') ?? '').trim();
  for (const [index, file] of files.entries()) {
    const form = new FormData();
    for (const [key, value] of metadata) if (key !== 'file' && key !== 'title') form.append(key, value);
    form.set('uploadRequestId', crypto.randomUUID());
    form.set('file', file);
    form.set('title', (title ? (files.length === 1 ? title : `${title} — ${file.name}`) : file.name).slice(0, 200));
    try { progress({ index, result: await send(form) }); }
    catch {
      progress({ index, result: { ok: false, message: 'Esito non confermato. Controlla l’elenco documenti prima di ripetere questo file.' } });
      // A lost response may follow a successful write. Do not resend or continue blindly.
      break;
    }
  }
}
