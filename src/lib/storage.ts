export async function createSignedDocumentUrl(storagePath: string) { return `/api/documents/signed?path=${encodeURIComponent(storagePath)}&expires=900`; }
