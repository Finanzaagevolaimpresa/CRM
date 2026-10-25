import { documentPreviewMaxBytes, documentPreviewMime } from './document-preview';
import { selectedDocumentMode } from './selected-document-formats';

/** Call only inside an authorized exact-version reader, after verifying its
 * checksum and explicit download permission. Never render active formats inline. */
export function selectedDocumentResponseMime(document: { fileName: string; mimeType: string }, bytes: Uint8Array, download: boolean) {
  const mode = selectedDocumentMode(document);
  if (!mode || !bytes.length || bytes.length > documentPreviewMaxBytes) throw new Error('SELECTED_DOCUMENT_CONTENT_UNAVAILABLE');
  if (download) return 'application/octet-stream';
  const preview = mode === 'preview' ? documentPreviewMime(document.fileName, bytes) : null;
  if (!preview || preview.split(';')[0] !== document.mimeType) throw new Error('SELECTED_DOCUMENT_CONTENT_UNAVAILABLE');
  return preview;
}
