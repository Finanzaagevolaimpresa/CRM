import { z } from 'zod';

export const technicalWorkItemCatalogueQuery = z.object({
  query: z.string().trim().max(200).default(''),
  kind: z.enum(['ALL', 'ChecklistItem', 'Task']).default('ALL'),
  page: z.number().int().min(1).max(300).default(1),
}).strict();
export type TechnicalWorkItemCatalogueQuery = z.infer<typeof technicalWorkItemCatalogueQuery>;
export type TechnicalWorkItemOption = { kind: 'ChecklistItem' | 'Task'; itemId: string;
  generation: number; scopeGeneration: number; scopeSha256: string; title: string };
export type TechnicalWorkItemCatalogue = { options: TechnicalWorkItemOption[];
  query: TechnicalWorkItemCatalogueQuery; hasNext: boolean };
export type TechnicalWorkItemChoices = Record<string, { option: TechnicalWorkItemOption; readable: string[]; editable: string[] }>;
export const technicalWorkItemPageSize = 20;
export const technicalWorkItemCandidateLimit = 6000;
export const technicalWorkItemOptionKey = (item: Pick<TechnicalWorkItemOption, 'kind' | 'itemId'>) => `${item.kind}:${item.itemId}`;

/** Call only after current source/context/document admission. No SQL pattern or
 * regular expression is built from this literal search term. */
export function matchesTechnicalWorkItemOption(item: TechnicalWorkItemOption, query: TechnicalWorkItemCatalogueQuery) {
  return (query.kind === 'ALL' || item.kind === query.kind)
    && item.title.normalize('NFC').toLocaleLowerCase('it-IT')
      .includes(query.query.normalize('NFC').toLocaleLowerCase('it-IT'));
}

/** Choices carry the exact snapshot the Admin selected. A later page must not
 * refresh a selected generation silently or omit an off-page choice. The server
 * still rereads every selected source in the signed preview and confirmation. */
export function selectedTechnicalWorkItemGrants(choices: TechnicalWorkItemChoices, actions: string[]) {
  return Object.values(choices).filter(choice => actions.includes(choice.option.kind === 'Task' ? 'manage_deadlines' : 'manage_checklist'))
    .map(({ option, readable, editable }) => ({ kind: option.kind, itemId: option.itemId,
      generation: option.generation, scopeGeneration: option.scopeGeneration, scopeSha256: option.scopeSha256,
      readableFields: readable, editableFields: editable }));
}
