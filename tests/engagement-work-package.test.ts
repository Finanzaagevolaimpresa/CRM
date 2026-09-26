import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildWorkPackage, workBytesHash, workImportInputSchema, type WorkManifest } from '../src/lib/engagement-work-package';

function fixture(): WorkManifest {
  return {
    protocol: 'FAI_CRM_MANUAL_WORK_PACKAGE_V1', purpose: 'INTERNAL_WORK_ONLY', packageId: randomUUID(),
    exportedAt: '2026-09-26T20:00:00.000Z', exportedById: 'synthetic-operator', dossierId: 'synthetic-dossier',
    sourceVersionId: randomUUID(), sourceVersion: 1, sourceVersionHash: 'a'.repeat(64),
    client: { id: 'synthetic-client', name: 'Cliente sintetico' }, project: { id: 'synthetic-project', title: 'Progetto sintetico' },
    service: { id: 'synthetic-service', revisionId: randomUUID(), revisionHash: 'b'.repeat(64), name: 'Verifica', assignedToId: 'synthetic-operator', dueAt: null },
    engagement: { practiceId: randomUUID(), acceptedOfferRevisionId: randomUUID(), offerHash: 'c'.repeat(64), scope: 'Scope sintetico', contractId: null, formalizationId: null, startedAt: '2026-09-26T19:00:00.000Z' },
    materialSnapshotHash: 'd'.repeat(64), materials: [],
    files: [{ name: 'materiali/1.pdf', documentId: 'doc', documentVersionId: 'doc-v1', sha256: workBytesHash('123456789'), bytes: 9 }],
    notice: 'Trasferimento manuale autorizzato. Nessuna sincronizzazione, approvazione o consegna al cliente.',
  };
}

test('Work archive is reproducible and carries exact source bytes, checksums and provenance', () => {
  const manifest = fixture(), documents = new Map([['doc-v1', Buffer.from('123456789')]]);
  const archive = buildWorkPackage(manifest, '# Risultato di lavoro', documents);
  assert.deepEqual(buildWorkPackage(manifest, '# Risultato di lavoro', documents), archive);
  const entries = new Map<string, { crc: number; bytes: Buffer }>();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(archive.readUInt16LE(offset + 8), 0);
    const size = archive.readUInt32LE(offset + 18), nameLength = archive.readUInt16LE(offset + 26), extraLength = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, { crc: archive.readUInt32LE(offset + 14), bytes: archive.subarray(start, start + size) });
    offset = start + size;
  }
  assert.equal(archive.readUInt32LE(offset), 0x02014b50);
  assert.deepEqual(JSON.parse(entries.get('manifest.json')!.bytes.toString()), manifest);
  assert.equal(entries.get('dossier-di-lavoro.md')!.bytes.toString(), '# Risultato di lavoro');
  assert.equal(entries.get('materiali/1.pdf')!.crc, 0xcbf43926); // Known CRC32 test vector.
  assert.equal(entries.get('materiali/1.pdf')!.bytes.toString(), '123456789');
  assert.notEqual(workBytesHash(buildWorkPackage(manifest, 'changed', documents)), workBytesHash(archive));
});

test('Work archive rejects path traversal, omitted files, corruption and duplicate names', () => {
  const manifest = fixture(), documents = new Map([['doc-v1', Buffer.from('123456789')]]);
  assert.throws(() => buildWorkPackage({ ...manifest, files: [{ ...manifest.files[0], name: '../secret' }] }, 'draft', documents));
  assert.throws(() => buildWorkPackage(manifest, 'draft', new Map()), /WORK_MATERIAL_MISMATCH/);
  assert.throws(() => buildWorkPackage(manifest, 'draft', new Map([['doc-v1', Buffer.from('987654321')]])), /WORK_MATERIAL_MISMATCH/);
  assert.throws(() => buildWorkPackage({ ...manifest, files: [...manifest.files, ...manifest.files] }, 'draft', documents), /WORK_PACKAGE_LIMIT/);
});

test('manual result requires source package, actor-declared provenance and an unambiguous instant', () => {
  const input = { dossierId: 'dossier', packageId: randomUUID(), packageArtifactHash: 'a'.repeat(64), expectedVersionId: randomUUID(), title: 'Risultato', content: 'Contenuto', workReference: 'WORK-SYNTHETIC-001', producer: 'A04', returnedAt: '2026-09-26T22:30:00+02:00' };
  assert.equal(workImportInputSchema.parse(input).returnedAt, '2026-09-26T20:30:00.000Z');
  assert.equal(workImportInputSchema.safeParse({ ...input, returnedAt: '2026-09-26T22:30' }).success, false);
  assert.equal(workImportInputSchema.safeParse({ ...input, producer: '' }).success, false);
  assert.equal(workImportInputSchema.safeParse({ ...input, packageArtifactHash: 'invented' }).success, false);
});
