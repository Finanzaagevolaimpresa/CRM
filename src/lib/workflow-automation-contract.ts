import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';

export const workflowEvents = ['LEAD_ACCEPTED', 'APPOINTMENT_BOOKED', 'DOCUMENT_REQUESTED', 'ASSIGNMENT_CONFIRMED', 'STATUS_CHANGED', 'NEWSLETTER'] as const;
export const workflowEventLabels: Record<typeof workflowEvents[number], string> = {
  LEAD_ACCEPTED: 'Nuovo lead associato', APPOINTMENT_BOOKED: 'Appuntamento fissato',
  DOCUMENT_REQUESTED: 'Documenti richiesti', ASSIGNMENT_CONFIRMED: 'Assegnazione definitiva',
  STATUS_CHANGED: 'Cambio di stato', NEWSLETTER: 'Newsletter programmata',
};
export const workflowPurposes = ['CONFIRMATION', 'FOLLOW_UP', 'APPOINTMENT', 'DOCUMENT_REQUEST', 'NEWSLETTER', 'INTERNAL_NOTICE'] as const;
export const workflowPurposeLabels: Record<typeof workflowPurposes[number], string> = {
  CONFIRMATION: 'Conferma acquisizione', FOLLOW_UP: 'Sollecito', APPOINTMENT: 'Conferma appuntamento',
  DOCUMENT_REQUEST: 'Richiesta documenti', NEWSLETTER: 'Newsletter', INTERNAL_NOTICE: 'Avviso interno',
};
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const plainSubject = z.string().trim().min(1).max(200).refine(value => !/[\r\n\u0000]/.test(value));
const placeholders = ['firstName', 'companyName', 'appointmentAt', 'documentList', 'unsubscribeUrl'] as const;
export function templateFields(text: string) {
  const fields = [...text.matchAll(/\{\{([^{}]+)\}\}/g)].map(match => match[1].trim());
  if (fields.some(field => !placeholders.includes(field as typeof placeholders[number]))
    || /[{}]/.test(text.replace(/\{\{[^{}]+\}\}/g, ''))) throw new Error('WORKFLOW_TEMPLATE_FIELD_UNKNOWN');
  return [...new Set(fields)];
}
export const workflowTemplateInput = z.object({
  id: z.string().uuid(), familyId: z.string().uuid(), expectedVersion: z.number().int().min(0).max(1_000_000),
  name: z.string().trim().min(1).max(160), purpose: z.enum(workflowPurposes),
  subject: plainSubject, body: z.string().trim().min(1).max(20_000),
  state: z.enum(['DRAFT', 'PUBLISHED']), authorizationReference: z.string().trim().max(200).nullable(),
}).strict().superRefine((input, ctx) => {
  try { templateFields(input.subject + '\n' + input.body); } catch { ctx.addIssue({ code: 'custom', message: 'Campi non riconosciuti nel modello.' }); }
  if (input.state === 'PUBLISHED' && !input.authorizationReference)
    ctx.addIssue({ code: 'custom', message: 'Indica il riferimento all’autorizzazione del testo aziendale.' });
  if (input.purpose === 'NEWSLETTER' && !input.body.includes('{{unsubscribeUrl}}'))
    ctx.addIssue({ code: 'custom', message: 'La newsletter richiede il collegamento di disiscrizione.' });
});
export const workflowConfiguration = z.object({
  kind: z.enum(['INDIVIDUAL', 'NEWSLETTER']), action: z.enum(['EMAIL', 'INTERNAL_NOTICE']),
  confirmationTemplateId: z.string().uuid(), followupTemplateId: z.string().uuid().nullable(),
  requireAssociated: z.literal(true), stopOnReply: z.literal(true), stopOnAppointment: z.literal(true),
  newsletterAt: z.string().datetime({ offset: true }).nullable(),
  recipientIds: z.array(identifier).max(500).refine(values => new Set(values).size === values.length),
}).strict();
export const workflowRuleInput = z.object({
  id: z.string().uuid(), expectedVersion: z.number().int().min(0).max(1_000_000),
  name: z.string().trim().min(1).max(160), event: z.enum(workflowEvents),
  state: z.enum(['DRAFT', 'TEST_READY', 'ACTIVE']), delayMinutes: z.number().int().min(1).max(43_200),
  configuration: workflowConfiguration,
}).strict().superRefine((input, ctx) => {
  if ((input.event === 'NEWSLETTER') !== (input.configuration.kind === 'NEWSLETTER'))
    ctx.addIssue({ code: 'custom', message: 'La newsletter deve avere un percorso separato.' });
  if (input.configuration.kind === 'NEWSLETTER' && (!input.configuration.newsletterAt || !input.configuration.recipientIds.length
    || input.configuration.followupTemplateId || input.configuration.action !== 'EMAIL'))
    ctx.addIssue({ code: 'custom', message: 'Seleziona destinatari e data; la newsletter non ha solleciti individuali.' });
  if (input.configuration.kind === 'INDIVIDUAL' && (input.configuration.newsletterAt || input.configuration.recipientIds.length))
    ctx.addIssue({ code: 'custom', message: 'La sequenza individuale usa la scheda dell’evento.' });
});
export type WorkflowRule = z.infer<typeof workflowRuleInput>;
export type WorkflowTemplate = Pick<z.infer<typeof workflowTemplateInput>, 'id' | 'name' | 'purpose' | 'subject' | 'body' | 'state' | 'authorizationReference'>;
export type WorkflowFields = Partial<Record<typeof placeholders[number], string>>;
export function renderWorkflowTemplate(template: WorkflowTemplate, values: WorkflowFields) {
  if (template.state !== 'PUBLISHED' || !template.authorizationReference) throw new Error('WORKFLOW_TEMPLATE_NOT_APPROVED');
  const fields = templateFields(template.subject + '\n' + template.body);
  const missing = fields.filter(field => !values[field as keyof WorkflowFields]?.trim());
  if (missing.length) return { ok: false as const, missing };
  const replace = (text: string) => text.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => values[key.trim() as keyof WorkflowFields]!);
  const subject = plainSubject.parse(replace(template.subject));
  const body = replace(template.body);
  if (template.purpose === 'NEWSLETTER') {
    const unsubscribe = new URL(values.unsubscribeUrl!);
    if (unsubscribe.protocol !== 'https:' || unsubscribe.username || unsubscribe.password) throw new Error('WORKFLOW_UNSUBSCRIBE_INVALID');
  }
  return { ok: true as const, subject, body, hash: canonicalSha256({ templateId: template.id, subject, body }) };
}

type JobState = 'WAITING' | 'ACCEPTED' | 'DELIVERED' | 'ERROR' | 'UNCERTAIN' | 'STOPPED';
export type SyntheticWorkflowJob = { key: string; eventId: string; step: 'CONFIRMATION' | 'FOLLOW_UP';
  dueAt: string; state: JobState; reason: string | null; attempts: number; receiptId: string | null; };
export type SyntheticWorkflowEvent = { id: string; kind: typeof workflowEvents[number]; leadId: string;
  receiptId: string; associated: boolean; occurredAt: string; fields: WorkflowFields; marketingEligible?: boolean; };
export type SyntheticWorkflowLog = { eventId: string; event: string; at: string; jobKey: string | null; evidence: string | null };

/** In-memory qualification only. It has no transport, database, scheduler or
 * provider import. A test outcome is never evidence of a real delivery. */
export class SyntheticWorkflowRun {
  readonly jobs: SyntheticWorkflowJob[] = [];
  readonly log: SyntheticWorkflowLog[] = [];
  readonly receipts: Array<{ id: string; jobKey: string; attempt: number; outcome: string }> = [];
  private readonly sources = new Map<string, { hash: string; event: SyntheticWorkflowEvent }>();
  private readonly stopped = new Map<string, string>();
  constructor(readonly rule: WorkflowRule, readonly templates: readonly WorkflowTemplate[]) {
    workflowRuleInput.parse(rule);
  }
  ingest(event: SyntheticWorkflowEvent) {
    identifier.parse(event.id); identifier.parse(event.leadId); identifier.parse(event.receiptId);
    z.string().datetime({ offset: true }).parse(event.occurredAt);
    const hash = canonicalSha256(event), previous = this.sources.get(event.id);
    if (previous) {
      if (previous.hash !== hash) throw new Error('WORKFLOW_EVENT_CONFLICT');
      return 'REPLAY' as const;
    }
    if (event.kind !== this.rule.event || !event.associated) return 'HELD' as const;
    this.sources.set(event.id, { hash, event });
    const at = this.rule.configuration.newsletterAt ?? event.occurredAt;
    for (const step of ['CONFIRMATION', ...(this.rule.configuration.followupTemplateId ? ['FOLLOW_UP'] : [])] as Array<'CONFIRMATION' | 'FOLLOW_UP'>) {
      const key = canonicalSha256({ ruleId: this.rule.id, eventId: event.id, step });
      this.jobs.push({ key, eventId: event.id, step,
        dueAt: step === 'CONFIRMATION' ? at : new Date(new Date(at).getTime() + this.rule.delayMinutes * 60_000).toISOString(),
        state: 'WAITING', reason: null, attempts: 0, receiptId: null });
    }
    this.log.push({ eventId: event.id, event: 'ENROLLED_SYNTHETIC', at: event.occurredAt, jobKey: null, evidence: event.receiptId });
    return 'RECORDED' as const;
  }
  observe(eventId: string, kind: 'REPLIED' | 'APPOINTMENT_BOOKED' | 'CLICKED' | 'UNSUBSCRIBED', at: string, evidence: string) {
    if (!this.sources.has(eventId) || !evidence.trim()) throw new Error('WORKFLOW_EVIDENCE_REQUIRED');
    z.string().datetime({ offset: true }).parse(at);
    if (this.log.some(row => row.eventId === eventId && row.event === kind && row.evidence === evidence)) return;
    this.log.push({ eventId, event: kind, at, jobKey: null, evidence });
    if (kind === 'CLICKED') return;
    this.stopped.set(eventId, kind);
    for (const job of this.jobs) if (job.eventId === eventId && job.state === 'WAITING'
      && (job.step === 'FOLLOW_UP' || kind === 'UNSUBSCRIBED')) { job.state = 'STOPPED'; job.reason = kind; }
  }
  runDue(now: string, outcome: 'ACCEPTED' | 'ERROR' | 'UNCERTAIN' = 'ACCEPTED') {
    z.string().datetime({ offset: true }).parse(now);
    for (const job of this.jobs) {
      if (job.state !== 'WAITING' || new Date(job.dueAt) > new Date(now)) continue;
      const source = this.sources.get(job.eventId)!.event;
      const stop = this.stopped.get(job.eventId);
      if (stop && (job.step === 'FOLLOW_UP' || stop === 'UNSUBSCRIBED')) { job.state = 'STOPPED'; job.reason = stop; continue; }
      if (this.rule.configuration.kind === 'NEWSLETTER' && source.marketingEligible !== true) {
        job.state = 'STOPPED'; job.reason = 'MARKETING_PREFERENCE_NOT_ELIGIBLE'; continue;
      }
      if (job.step === 'FOLLOW_UP' && !this.jobs.some(row => row.eventId === job.eventId && row.step === 'CONFIRMATION'
        && ['ACCEPTED', 'DELIVERED'].includes(row.state))) { job.reason = 'CONFIRMATION_NOT_CONFIRMED'; continue; }
      const id = job.step === 'CONFIRMATION' ? this.rule.configuration.confirmationTemplateId : this.rule.configuration.followupTemplateId;
      const template = this.templates.find(value => value.id === id);
      if (!template) { job.state = 'ERROR'; job.reason = 'TEMPLATE_UNAVAILABLE'; continue; }
      let rendered: ReturnType<typeof renderWorkflowTemplate>;
      try { rendered = renderWorkflowTemplate(template, source.fields); }
      catch { job.state = 'ERROR'; job.reason = 'TEMPLATE_NOT_APPROVED'; continue; }
      if (!rendered.ok) { job.state = 'ERROR'; job.reason = 'MISSING_FIELDS:' + rendered.missing.join(','); continue; }
      job.attempts++;
      job.state = outcome;
      job.reason = outcome === 'ACCEPTED' ? null : outcome === 'UNCERTAIN' ? 'RECONCILE_BEFORE_RETRY' : 'TEST_CHANNEL_REJECTED';
      job.receiptId = canonicalSha256({ jobKey: job.key, attempt: job.attempts });
      this.receipts.push({ id: job.receiptId, jobKey: job.key, attempt: job.attempts, outcome });
      this.log.push({ eventId: job.eventId, event: outcome, at: now, jobKey: job.key, evidence: job.receiptId });
    }
  }
  reconcile(jobKey: string, outcome: 'ACCEPTED' | 'NOT_ACCEPTED', at: string, evidence: string) {
    const job = this.jobs.find(row => row.key === jobKey);
    if (!job || job.state !== 'UNCERTAIN' || !evidence.trim()) throw new Error('WORKFLOW_RECONCILIATION_INVALID');
    z.string().datetime({ offset: true }).parse(at);
    job.state = outcome === 'ACCEPTED' ? 'ACCEPTED' : this.stopped.has(job.eventId) ? 'STOPPED' : 'WAITING';
    job.reason = job.state === 'STOPPED' ? this.stopped.get(job.eventId)! : null;
    this.log.push({ eventId: job.eventId, event: 'RECONCILED_' + outcome, at, jobKey, evidence });
  }
  delivery(jobKey: string, at: string, evidence: string) {
    const job = this.jobs.find(row => row.key === jobKey);
    if (!job || !['ACCEPTED', 'DELIVERED'].includes(job.state) || !evidence.trim()) throw new Error('WORKFLOW_DELIVERY_EVIDENCE_REQUIRED');
    z.string().datetime({ offset: true }).parse(at);
    if (job.state === 'DELIVERED') return;
    job.state = 'DELIVERED';
    this.log.push({ eventId: job.eventId, event: 'DELIVERED', at, jobKey, evidence });
  }
}
