import { createHash } from 'node:crypto';
import { z } from 'zod';

export const WORK_PACKAGE_EVENT = 'engagement_work_package_export';
export const WORK_IMPORT_EVENT = 'engagement_work_result_import';
export const WORK_PACKAGE_MAX_BYTES = 50 * 1024 * 1024;
const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const workManifestSchema = z.object({
  protocol: z.literal('FAI_CRM_MANUAL_WORK_PACKAGE_V1'),
  purpose: z.literal('INTERNAL_WORK_ONLY'),
  packageId: z.string().uuid(),
  exportedAt: z.string().datetime(),
  exportedById: id,
  dossierId: id,
  sourceVersionId: z.string().uuid(),
  sourceVersion: z.number().int().positive(),
  sourceVersionHash: hash,
  client: z.object({ id, name: z.string().max(500) }).strict(),
  project: z.object({ id, title: z.string().max(500) }).strict(),
  service: z.object({ id, revisionId: z.string().uuid(), revisionHash: hash, name: z.string().max(500), assignedToId: id.nullable(), dueAt: z.string().datetime().nullable() }).strict(),
  engagement: z.object({ practiceId: z.string().uuid(), acceptedOfferRevisionId: z.string().uuid(), offerHash: hash, scope: z.string().max(4000), contractId: id.nullable(), formalizationId: z.string().uuid().nullable(), startedAt: z.string().datetime() }).strict(),
  materialSnapshotHash: hash,
  materials: z.array(z.object({ checklistItemId: id, evidenceId: z.string().uuid(), status: z.string().max(32), documentVersionId: id.nullable(), checksum: hash.nullable() }).strict()).max(100),
  files: z.array(z.object({ name: z.string().regex(/^materiali\/[0-9]+\.[a-z0-9]{1,8}$/), documentId: id, documentVersionId: id, sha256: hash, bytes: z.number().int().positive().max(WORK_PACKAGE_MAX_BYTES) }).strict()).max(100),
  notice: z.literal('Trasferimento manuale autorizzato. Nessuna sincronizzazione, approvazione o consegna al cliente.'),
}).strict();
export type WorkManifest = z.infer<typeof workManifestSchema>;

export const workExportReceiptSchema = z.object({
  protocol: z.literal('FAI_CRM_WORK_EXPORT_RECEIPT_V1'),
  manifest: workManifestSchema,
  manifestHash: hash,
  artifactHash: hash,
}).strict();

export const workImportInputSchema = z.object({
  dossierId: id, packageId: z.string().uuid(), packageArtifactHash: hash,
  expectedVersionId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(200_000),
  workReference: z.string().trim().min(1).max(240),
  producer: z.string().trim().min(1).max(120),
  returnedAt: z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString()),
});

export const workImportReceiptSchema = z.object({
  protocol: z.literal('FAI_CRM_MANUAL_WORK_IMPORT_V1'),
  packageId: z.string().uuid(), packageArtifactHash: hash,
  sourceVersionId: z.string().uuid(), sourceVersionHash: hash,
  versionId: z.string().uuid(), versionHash: hash,
  workReference: z.string().min(1).max(240), producer: z.string().min(1).max(120),
  returnedAt: z.string().datetime(), importHash: hash,
}).strict();
export type WorkImportReceipt = z.infer<typeof workImportReceiptSchema>;

export function workBytesHash(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Stored ZIP with fixed timestamps; entries are constructed here, never extracted from input. */
export function buildWorkPackage(manifest: WorkManifest, content: string, materials: Map<string, Buffer>) {
  workManifestSchema.parse(manifest);
  const files = [
    { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
    { name: 'dossier-di-lavoro.md', bytes: Buffer.from(content) },
    { name: 'LEGGIMI.txt', bytes: Buffer.from('Pacchetto interno per lavorazione manuale autorizzata. Conserva manifest e hash del file ZIP. Riporta nel CRM il risultato, il riferimento Work e il produttore. Il rientro crea una nuova bozza da revisionare; non invia nulla al cliente.\n') },
    ...manifest.files.map(file => {
      const bytes = materials.get(file.documentVersionId);
      if (!bytes || bytes.length !== file.bytes || workBytesHash(bytes) !== file.sha256) throw new Error('WORK_MATERIAL_MISMATCH');
      return { name: file.name, bytes };
    }),
  ];
  if (new Set(files.map(file => file.name)).size !== files.length
    || files.reduce((sum, file) => sum + file.bytes.length, 0) > WORK_PACKAGE_MAX_BYTES) throw new Error('WORK_PACKAGE_LIMIT');
  const chunks: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), checksum = crc32(file.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(file.bytes.length, 18);
    header.writeUInt32LE(file.bytes.length, 22); header.writeUInt16LE(name.length, 26);
    chunks.push(header, name, file.bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.bytes.length, 20); central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, name); offset += header.length + name.length + file.bytes.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, central, end]);
}
