import { Buffer } from 'node:buffer';

const FAI_DISCLAIMER = 'Documento interno di lavoro. Finanza Agevola Impresa S.r.l. non eroga finanziamenti, non promette contributi e non garantisce esiti o erogazioni. Offre consulenza tecnica, strategica e di orientamento.';

type DossierDocxInput = {
  title: string;
  client: {
    displayName: string;
    type: string;
    status: string;
    notes?: string | null;
  };
  dossierType: string;
  dossierStatus: string;
  exportedAt: Date;
  content: string;
};

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function paragraph(text: string, style?: string) {
  const pStyle = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pStyle}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function bullet(text: string) {
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function markdownToWordXml(markdown: string) {
  return markdown.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return paragraph('');
    if (trimmed.startsWith('## ')) return paragraph(trimmed.slice(3).trim(), 'Heading2');
    if (trimmed.startsWith('# ')) return paragraph(trimmed.slice(2).trim(), 'Heading1');
    if (trimmed.startsWith('- ')) return bullet(trimmed.slice(2).trim());
    return paragraph(trimmed);
  }).join('');
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u32(value: number) { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }

function zip(files: Array<{ name: string; content: string }>) {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
    chunks.push(local);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += local.length;
  }

  const centralDirectory = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralDirectory.length), u32(offset), u16(0)]);
  return Buffer.concat([...chunks, centralDirectory, end]);
}

export function buildClientDossierDocx(input: DossierDocxInput) {
  const exportedAt = input.exportedAt.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
  const body = [
    paragraph('Finanza Agevola Impresa S.r.l.', 'Title'),
    paragraph(input.title, 'Heading1'),
    paragraph('Dati cliente', 'Heading2'),
    paragraph(`Cliente: ${input.client.displayName}`),
    paragraph(`Tipologia cliente: ${input.client.type}`),
    paragraph(`Stato cliente: ${input.client.status}`),
    input.client.notes ? paragraph(`Note cliente: ${input.client.notes}`) : '',
    paragraph(`Tipo bozza: ${input.dossierType.replaceAll('_', ' ')}`),
    paragraph(`Stato bozza: ${input.dossierStatus}`),
    paragraph(`Data generazione/export: ${exportedAt}`),
    paragraph('Contenuto', 'Heading2'),
    markdownToWordXml(input.content),
    paragraph('Nota FAI', 'Heading2'),
    paragraph(FAI_DISCLAIMER),
  ].join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style></w:styles>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  return zip([
    { name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>` },
    { name: '_rels/.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>` },
    { name: 'word/document.xml', content: document },
    { name: 'word/styles.xml', content: styles },
    { name: 'word/numbering.xml', content: numbering },
  ]);
}

export const COMMERCIAL_OFFER_DISCLAIMER = 'Finanza Agevola Impresa S.r.l. non eroga finanziamenti, non promette contributi, non garantisce esiti o erogazioni e non opera come intermediario finanziario. Offre consulenza tecnica, strategica e di orientamento.';

type CommercialOfferDocxInput = {
  title: string;
  lead?: { name: string; email?: string | null; phone?: string | null; interest?: string | null } | null;
  client?: { displayName: string; type: string; status: string } | null;
  status: string;
  description?: string | null;
  services?: string | null;
  includedActivities?: string | null;
  taxableAmount: number;
  vatAmount: number;
  totalAmount: number;
  validUntil?: Date | null;
  operationalConditions?: string | null;
  commercialProposal?: string | null;
  exportedAt: Date;
};

function money(value: number) { return `€ ${value.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function dateIt(value?: Date | null) { return value ? value.toLocaleDateString('it-IT') : 'Da confermare'; }

export function buildCommercialOfferDocx(input: CommercialOfferDocxInput) {
  const subject = input.description || input.title;
  const body = [
    paragraph('Finanza Agevola Impresa S.r.l.', 'Title'),
    paragraph('Offerta commerciale FAI', 'Heading1'),
    paragraph(input.title, 'Heading2'),
    paragraph(`Data generazione/export: ${input.exportedAt.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}`),
    paragraph(`Stato offerta: ${input.status.replaceAll('_', ' ')}`),
    paragraph('Dati lead/cliente', 'Heading2'),
    input.lead ? paragraph(`Lead: ${input.lead.name}`) : '',
    input.lead?.email ? paragraph(`Email lead: ${input.lead.email}`) : '',
    input.lead?.phone ? paragraph(`Telefono lead: ${input.lead.phone}`) : '',
    input.lead?.interest ? paragraph(`Interesse dichiarato: ${input.lead.interest}`) : '',
    input.client ? paragraph(`Cliente: ${input.client.displayName}`) : '',
    input.client ? paragraph(`Tipologia cliente: ${input.client.type} · Stato: ${input.client.status}`) : '',
    paragraph('Oggetto offerta', 'Heading2'),
    paragraph(subject),
    paragraph('Servizi proposti', 'Heading2'),
    markdownToWordXml(input.services || 'Servizio personalizzato FAI da definire operativamente.'),
    paragraph('Descrizione attività incluse', 'Heading2'),
    markdownToWordXml(input.includedActivities || input.commercialProposal || 'Attività consulenziali tecniche, strategiche e di orientamento secondo quanto concordato con il referente FAI.'),
    paragraph('Importi', 'Heading2'),
    paragraph(`Prezzo imponibile: ${money(input.taxableAmount)}`),
    paragraph(`IVA 22%: ${money(input.vatAmount)}`),
    paragraph(`Totale IVA inclusa: ${money(input.totalAmount)}`),
    paragraph('Validità offerta', 'Heading2'),
    paragraph(dateIt(input.validUntil)),
    paragraph('Condizioni operative', 'Heading2'),
    markdownToWordXml(input.operationalConditions || 'L’avvio delle attività avviene dopo accettazione dell’offerta e ricezione della documentazione necessaria. Eventuali attività extra saranno concordate separatamente.'),
    paragraph('Disclaimer FAI', 'Heading2'),
    paragraph(COMMERCIAL_OFFER_DISCLAIMER),
  ].join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style></w:styles>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  return zip([
    { name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>` },
    { name: '_rels/.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>` },
    { name: 'word/document.xml', content: document }, { name: 'word/styles.xml', content: styles }, { name: 'word/numbering.xml', content: numbering },
  ]);
}
