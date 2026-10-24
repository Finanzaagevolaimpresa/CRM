/** Metadata classification only; this never authorizes a reader or a version.
 * Inline bytes must additionally pass selectedDocumentResponseMime. */
export const selectedDocumentMimeTypes = [
  'application/pdf', 'text/plain', 'image/png', 'image/jpeg',
  'application/octet-stream', 'image/webp', 'text/csv', 'text/xml', 'application/xml',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
  'application/pkcs7-mime', 'application/x-pkcs7-mime', 'application/zip', 'application/x-zip-compressed',
] as const;

const formats: Record<string, readonly string[]> = {
  pdf: ['application/pdf'], png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'], txt: ['text/plain'],
  webp: ['image/webp'], csv: ['text/csv', 'text/plain'], xml: ['application/xml', 'text/xml', 'text/plain'],
  doc: ['application/msword'], docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'], xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  odt: ['application/vnd.oasis.opendocument.text'], ods: ['application/vnd.oasis.opendocument.spreadsheet'],
  p7m: ['application/pkcs7-mime', 'application/x-pkcs7-mime'], zip: ['application/zip', 'application/x-zip-compressed'],
};
type Metadata = { fileName: string; mimeType: string };
export function selectedDocumentMode(document: Metadata): 'preview' | 'download' | null {
  if (!document.fileName || /[\\/\u0000-\u001f\u007f]/.test(document.fileName)) return null;
  const extension = document.fileName.toLowerCase().split('.').at(-1) ?? '';
  if (!Object.hasOwn(formats, extension)) return null;
  if (document.mimeType === 'application/octet-stream') return 'download';
  if (!formats[extension].includes(document.mimeType)) return null;
  return ['pdf', 'png', 'jpg', 'jpeg', 'txt'].includes(extension) ? 'preview' : 'download';
}
export const canPreviewSelectedDocument = (document: Metadata) => selectedDocumentMode(document) === 'preview';
export function selectedDocumentAccessLabel(document: Metadata, download: boolean) {
  if (canPreviewSelectedDocument(document)) return download ? 'Consultazione e download' : 'Consultazione';
  return download ? 'Download consentito · anteprima non disponibile' : 'Solo nome e versione · download non consentito';
}
