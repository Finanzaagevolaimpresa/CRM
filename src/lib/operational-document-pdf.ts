import { OperationalDocumentError } from './operational-document-contract';

export const proformaGenerationDeliveryNotice = 'Invio al cliente: non eseguito al momento della generazione.';

/** The immutable content chooses its rendering; previously generated PDFs keep their bytes. */
export function renderOperationalProformaPdf(row: { id: string; content: string }) {
  return renderOperationalPdf({ title: 'Proforma', content: row.content, reference: row.id,
    status: row.content.endsWith(proformaGenerationDeliveryNotice)
      ? 'Documento non fiscale · invio non eseguito alla generazione'
      : 'Documento non fiscale · invio non eseguito' });
}

const extra: Record<string, number> = { '€': 128, '‚': 130, 'ƒ': 131, '„': 132, '…': 133, '†': 134, '‡': 135,
  'ˆ': 136, '‰': 137, 'Š': 138, '‹': 139, 'Œ': 140, 'Ž': 142, '‘': 145, '’': 146, '“': 147, '”': 148,
  '•': 149, '–': 150, '—': 151, '˜': 152, '™': 153, 'š': 154, '›': 155, 'œ': 156, 'ž': 158, 'Ÿ': 159 };
function winAnsi(value: string) {
  return [...value.normalize('NFC')].map(character => {
    const code = character.charCodeAt(0), byte = code >= 32 && code <= 126 || code >= 160 && code <= 255 ? code : extra[character];
    if (byte === undefined) throw new OperationalDocumentError('PDF_CHARACTER');
    return '\\' + byte.toString(8).padStart(3, '0');
  }).join('');
}
function lines(value: string) {
  const rows: string[] = [];
  // Conservative Helvetica advance bounds at 10pt. Wide words and long opaque
  // references must wrap as well; a character-count limit alone can overflow.
  const width = (text: string) => [...text].reduce((sum, character) => sum + (
    /[MW@]/.test(character) || character.charCodeAt(0) > 126 ? 10.5
      : /[A-Z]/.test(character) ? 8.5 : character === 'm' ? 8.5 : character === 'w' ? 7.5
        : /[ilI.,'!:;| ]/.test(character) ? 3 : /[0-9]/.test(character) ? 5.6 : /[a-z]/.test(character) ? 6.5 : 10.5), 0);
  for (const paragraph of value.replace(/\r/g, '').split('\n')) {
    if (!paragraph) { rows.push(''); continue; }
    let line = '';
    for (const word of paragraph.replace(/\t/g, '    ').split(/ +/)) {
      if (width(line + (line ? ' ' : '') + word) > 490) { if (line) rows.push(line); line = ''; }
      let chunk = '';
      for (const character of word) {
        if (width(chunk + character) > 490) { rows.push(chunk); chunk = ''; }
        chunk += character;
      }
      line += (line && chunk ? ' ' : '') + chunk;
    }
    if (line) rows.push(line);
  }
  return rows;
}
/** Passive, deterministic PDF. Text is never interpreted as PDF operators, HTML or a URL. */
export function renderOperationalPdf(input: { title: string; content: string; reference: string; status: string }) {
  const rows = lines(input.content), pages = Math.max(1, Math.ceil(rows.length / 45));
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, index) => `${4 + index * 2} 0 R`).join(' ')}] >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  for (let index = 0; index < pages; index++) {
    const objectId = 4 + index * 2;
    objects[objectId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objectId + 1} 0 R >>`;
    const commands = ['BT /F1 16 Tf 45 790 Td (' + winAnsi(input.title) + ') Tj',
      '/F1 9 Tf 0 -23 Td (' + winAnsi(input.status) + ') Tj', '/F1 10 Tf 0 -28 Td'];
    for (const row of rows.slice(index * 45, (index + 1) * 45)) commands.push('(' + winAnsi(row) + ') Tj 0 -14 Td');
    commands.push('ET', 'BT /F1 8 Tf 45 30 Td (' + winAnsi(input.reference + ` | ${index + 1}/${pages}`) + ') Tj ET');
    const stream = commands.join('\n');
    objects[objectId + 1] = `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`;
  }
  let pdf = '%PDF-1.4\n', position = Buffer.byteLength(pdf);
  const offsets = [0];
  for (let index = 1; index < objects.length; index++) {
    offsets.push(position);
    const object = `${index} 0 obj\n${objects[index]}\nendobj\n`; pdf += object; position += Buffer.byteLength(object, 'ascii');
  }
  const xref = position;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}
