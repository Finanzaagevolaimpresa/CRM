import { z } from 'zod';
import type { TechnicalAssignmentSelection } from './technical-assignment-contract';

export const technicalDocumentCatalogueQuery = z.object({
  query: z.string().trim().max(200).default(''),
  page: z.number().int().min(1).max(13).default(1),
}).strict();
export type TechnicalDocumentCatalogueQuery = z.infer<typeof technicalDocumentCatalogueQuery>;
export type TechnicalDocumentOption = TechnicalAssignmentSelection['documents'][number] & {
  title: string; fileName: string; mimeType: string;
};
export type TechnicalDocumentCatalogue = { options: TechnicalDocumentOption[];
  query: TechnicalDocumentCatalogueQuery; hasNext: boolean };
export type TechnicalDocumentChoices = Record<string, { option: TechnicalDocumentOption; download: boolean }>;
export const technicalDocumentPageSize = 20;

/** Only already admitted metadata enters this function. Search is literal and
 * never changes the source capacity or the authorization of a version. */
export function pageTechnicalDocuments(admitted: TechnicalDocumentOption[], raw: TechnicalDocumentCatalogueQuery): TechnicalDocumentCatalogue {
  const query = technicalDocumentCatalogueQuery.parse(raw);
  const term = query.query.normalize('NFC').toLocaleLowerCase('it-IT');
  const matching = admitted.filter(row => [row.title, row.fileName].some(value =>
    value.normalize('NFC').toLocaleLowerCase('it-IT').includes(term)));
  const start = (query.page - 1) * technicalDocumentPageSize;
  return { query, options: matching.slice(start, start + technicalDocumentPageSize), hasNext: matching.length > start + technicalDocumentPageSize };
}

/** Preserve the exact snapshot originally chosen, including off-page versions.
 * The signed server preview and confirmation independently reread every field. */
export function selectedTechnicalDocuments(choices: TechnicalDocumentChoices): TechnicalAssignmentSelection['documents'] {
  return Object.values(choices).map(({ option, download }) => ({ documentId: option.documentId,
    fileId: option.fileId, version: option.version, contentSha256: option.contentSha256,
    contextSha256: option.contextSha256, allowDownload: download }));
}
