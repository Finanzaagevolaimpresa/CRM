import { z } from 'zod';

export type AccountFormState = { ok: boolean; message: string };
export const initialAccountFormState: AccountFormState = { ok: false, message: '' };

export const accountProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
});
export const accountPasswordSchema = z.string().min(12).max(72)
  .refine((value) => new TextEncoder().encode(value).length <= 72);
export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  password: accountPasswordSchema,
  confirmation: z.string(),
}).refine((value) => value.password === value.confirmation)
  .refine((value) => value.password !== value.currentPassword);
export const passwordResetSchema = z.object({
  password: accountPasswordSchema,
  confirmation: z.string(),
}).refine((value) => value.password === value.confirmation);
