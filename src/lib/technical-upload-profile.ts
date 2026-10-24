import { z } from 'zod';
import { documentUploadExtensions, documentUploadMaxBytes, documentUploadMaxFiles } from './document-upload-contract';

// Independent closed profile shared by retained assignment selections and the
// upload preview. No routes, storage, permissions or DB are imported here.
const formats = documentUploadExtensions.filter(value => value !== '.zip');
const format = z.enum(formats);
const maximumBytes = documentUploadMaxFiles * documentUploadMaxBytes;
export const technicalUploadProfile = z.object({
  purpose: z.string().trim().min(3).max(160),
  formats: z.array(format).min(1).max(formats.length).refine(value => new Set(value).size === value.length),
  maxFileBytes: z.number().int().min(1).max(documentUploadMaxBytes),
  maxFilesPerRevision: z.number().int().min(1).max(documentUploadMaxFiles),
  maxBytesPerRevision: z.number().int().min(1).max(maximumBytes),
  visibility: z.literal('PRIVATE_PENDING_ADMIN_REVIEW'),
}).strict().refine(value => value.maxBytesPerRevision >= value.maxFileBytes
  && value.maxBytesPerRevision <= value.maxFileBytes * value.maxFilesPerRevision, 'Bounded revision quota required');
export type TechnicalUploadProfile = z.infer<typeof technicalUploadProfile>;

