import type { previewPrivateTechnicalItem, readPrivateTechnicalItemOutcome } from './technical-private-item-service';
export type TechnicalPrivateItemState = { ok: boolean; message: string; uncertain?: boolean;
  preview?: Awaited<ReturnType<typeof previewPrivateTechnicalItem>>;
  outcome?: Awaited<ReturnType<typeof readPrivateTechnicalItemOutcome>> };
export type TechnicalPrivateItemAction = (previous: TechnicalPrivateItemState, form: FormData) => Promise<TechnicalPrivateItemState>;
