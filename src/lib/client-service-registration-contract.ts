import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const registrationDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T12:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const serviceRegistrationCommand = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('REGISTER'), commandId: z.string().uuid(), clientId: id,
    catalogId: id, contractId: id, paymentId: id.nullable(), purchasedOn: registrationDay }).strict(),
  z.object({ operation: z.literal('LINK_PAYMENT'), commandId: z.string().uuid(), clientId: id,
    serviceId: id, paymentId: id }).strict(),
]);
export type ServiceRegistrationCommand = z.infer<typeof serviceRegistrationCommand>;
export type ServiceRegistrationPreview = {
  digest: string; client: string; service: string; contract: string; scope: string; project: string | null;
  purchasedOn: string; payment: string | null; paymentStatus: string; operation: ServiceRegistrationCommand['operation'];
};
export class ServiceRegistrationError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'DUPLICATE' | 'INVALID' | 'CLOSED') { super(code); }
}
export function registrationServiceId(commandId: string) {
  return 'registered_service_' + z.string().uuid().parse(commandId).replaceAll('-', '');
}
