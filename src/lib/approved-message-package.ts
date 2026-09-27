import { createHash } from 'node:crypto';
import { approvedMessageHash, approvedMessageSnapshotSchema, type ApprovedMessageSnapshot } from './approved-communication-contract';

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Deterministic stored ZIP; no path or executable is accepted from a caller. */
export function buildApprovedMessagePackage(raw: ApprovedMessageSnapshot, materials: Map<string, Buffer>) {
  const message = approvedMessageSnapshotSchema.parse(raw);
  const manifest = {
    protocol: 'FAI_APPROVED_MANUAL_EMAIL_V1', snapshotHash: approvedMessageHash(message), message,
    messageReference: `<fai-${message.messageId}-v${message.revision}@crm.finanzaagevolaimpresa.it>`,
    method: 'MANUAL_EXTERNAL',
    instruction: 'Invio esterno manuale: usare esattamente questi campi e questi allegati. Non è una ricevuta di invio, consegna o lettura. Registrare l’esito nel CRM.',
  };
  const files = [
    { name: 'messaggio-approvato.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
    { name: 'messaggio-approvato.txt', bytes: Buffer.from([
      `Da: ${message.from}`, `Reply-To: ${message.replyTo}`, `A: ${message.to.join(', ')}`,
      `CC: ${message.cc.join(', ')}`, `BCC: ${message.bcc.join(', ')}`, `Oggetto: ${message.subject}`,
      '', message.body, '', `Riferimento CRM: ${manifest.messageReference}`, '', manifest.instruction,
    ].join('\r\n')) },
    ...message.attachments.map((item, i) => {
      const bytes = materials.get(item.versionId);
      if (!bytes || bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256)
        throw new Error('MESSAGE_MATERIAL_MISMATCH');
      return { name: `allegati/${i + 1}/${item.filename}`, bytes };
    }),
  ];
  const chunks: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), crc = crc32(file.bytes), local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(file.bytes.length, 18); local.writeUInt32LE(file.bytes.length, 22); local.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(file.bytes.length, 20); entry.writeUInt32LE(file.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    chunks.push(local, name, file.bytes); central.push(entry, name); offset += local.length + name.length + file.bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
