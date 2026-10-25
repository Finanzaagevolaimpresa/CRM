import type { previewTechnicalUpload } from './technical-upload-service';
import type { previewTechnicalUploadReview } from './technical-upload-review-service';
import type { previewTechnicalDocumentAcquisition } from './technical-document-acquisition-service';
export type TechnicalUploadState = { ok: boolean; message: string; uncertain?: boolean; recorded?: boolean;
  uploadPreview?: Awaited<ReturnType<typeof previewTechnicalUpload>>;
  reviewPreview?: Awaited<ReturnType<typeof previewTechnicalUploadReview>>;
  acquisitionPreview?: Awaited<ReturnType<typeof previewTechnicalDocumentAcquisition>> };
export type TechnicalUploadAction = (previous: TechnicalUploadState, form: FormData) => Promise<TechnicalUploadState>;
