import { z } from 'zod';

const optionalText = z.string().trim().max(5000).optional().or(z.literal('').transform(() => undefined));
const id = z.string().trim().min(1).max(128);
const money = z.coerce.number().finite().nonnegative();
const date = z.coerce.date();
const email = z.string().trim().email().optional().or(z.literal('').transform(() => undefined));

export const leadSchema = z.object({
  firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100), phone: optionalText, email,
  source: optionalText, region: optionalText, province: optionalText, interest: optionalText, declaredInvestment: money.optional(), notes: optionalText,
});
export const clientSchema = z.object({ type: z.enum(['persona_fisica','ditta_individuale','societa','professionista','soggetto_da_costituire','associazione','altro']), displayName: z.string().trim().min(1).max(200), leadId: id.optional(), notes: optionalText });
export const companySchema = z.object({ clientId: id, name: z.string().trim().min(1).max(200), vatNumber: optionalText, taxCode: optionalText, pec: email, province: optionalText, city: optionalText, legalForm: optionalText, durcStatus: optionalText, notes: optionalText });
export const projectSchema = z.object({ clientId: id, companyId: id.optional(), title: z.string().trim().min(1).max(200), description: optionalText, totalInvestment: money.optional(), requestedAmount: money.optional(), region: optionalText, province: optionalText, sector: optionalText });
export const projectExpenseSchema = z.object({ projectId: id, category: z.enum(['attrezzature','macchinari','mezzi','ristrutturazione','opere_edili','impianti','software','hardware','marketing','formazione','consulenze','liquidita','acquisto_immobile','affitto','personale','merce','eventi','spese_legali','altro']), description: z.string().trim().min(1).max(500), amount: money, estimated: z.coerce.boolean().optional(), potentiallyEligible: z.coerce.boolean().optional(), eligibilityNotes: optionalText });
export const serviceStatusSchema = z.enum(['richiesto','pagato','raccolta_documenti','in_lavorazione','bozza_ai','revisione_umana','consegnabile','consegnato','sospeso','chiuso','archiviato']);
export const serviceAreaSchema = z.enum(['anagrafica','bancabilita','finanziamento_aziendale','bandi_finanza_agevolata','progetto_investimento','contratti','pagamenti','dossier','output_ai','altro']);
export const documentCategorySchema = z.string().trim().min(1).max(120);
export const serviceCatalogSchema = z.object({ code: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(200), description: optionalText, category: z.string().trim().min(1).max(120), basePrice: money.optional(), active: z.coerce.boolean().optional(), displayOrder: z.coerce.number().int().nonnegative().optional() });
export const clientServiceSchema = z.object({ clientId: id, companyId: id.optional(), projectId: id.optional(), serviceCatalogId: id, contractId: id.optional(), paymentId: id.optional(), status: serviceStatusSchema.optional(), paymentStatus: z.enum(['da_incassare','parziale','incassato','scaduto','stornato','rimborsato']).optional(), assignedToId: id.optional(), purchasedAt: date.optional(), dueDate: date.optional(), completedAt: date.optional(), internalNotes: optionalText });
export const documentServiceLinkSchema = z.object({ documentId: id, clientServiceId: id.optional(), serviceArea: serviceAreaSchema, documentCategory: documentCategorySchema });

export const documentSchema = z.object({ clientId: id.optional(), companyId: id.optional(), projectId: id.optional(), clientServiceId: id.optional(), serviceArea: serviceAreaSchema.optional(), documentCategory: documentCategorySchema.optional(), title: z.string().trim().min(1).max(200), type: z.string().trim().min(1).max(80), fileName: z.string().trim().min(1).max(255), mimeType: z.string().trim().min(1).max(120), sizeBytes: z.coerce.number().int().positive().max(50 * 1024 * 1024), storagePath: z.string().trim().min(1).max(1000).refine((value) => !value.startsWith('http') && !value.includes('..'), 'storagePath must be private and relative'), containsSensitiveData: z.coerce.boolean().optional(), validUntil: date.optional() });
export const documentUploadSchema = z.object({ clientId: id, companyId: id.optional(), projectId: id.optional(), clientServiceId: id.optional(), serviceArea: serviceAreaSchema.default('altro'), documentCategory: documentCategorySchema.default('altro'), title: z.string().trim().min(1).max(200), containsSensitiveData: z.coerce.boolean().optional(), validUntil: date.optional() });


export const taskStatusSchema = z.enum(['aperta','in_lavorazione','completata','annullata']);
export const taskPrioritySchema = z.enum(['bassa','media','alta','urgente']);
export const clientTaskSchema = z.object({ clientId: id, clientServiceId: id.optional(), projectId: id.optional(), title: z.string().trim().min(1).max(200), description: optionalText, status: taskStatusSchema.optional(), priority: taskPrioritySchema.default('media'), assignedToId: id.optional(), dueAt: date.optional() });
export const taskUpdateSchema = z.object({ id, status: taskStatusSchema, priority: taskPrioritySchema, assignedToId: id.optional(), dueAt: date.optional() });
export const taskIdSchema = z.object({ id });

export const checklistStatusSchema = z.enum(['da_richiedere','richiesto','ricevuto','validato','non_necessario']);
export const documentChecklistItemSchema = z.object({ clientId: id, clientServiceId: id.optional(), projectId: id.optional(), title: z.string().trim().min(1).max(200), notes: optionalText, status: checklistStatusSchema.optional(), documentId: id.optional() });
export const checklistItemIdSchema = z.object({ id });
export const checklistItemStatusUpdateSchema = z.object({ id, status: checklistStatusSchema });
export const checklistItemDocumentLinkSchema = z.object({ id, documentId: id });

export const preAnalysisSchema = z.object({ projectId: id, clientId: id, companyId: id.optional(), internalSummary: optionalText, scenarioA: optionalText, scenarioB: optionalText, blockingConditions: optionalText, requiredDocuments: optionalText });
export const dossierSchema = z.object({ projectId: id, clientId: id, preAnalysisId: id.optional(), title: z.string().trim().min(1).max(200), type: z.string().trim().min(1).max(80), markdownContent: optionalText, jsonContent: z.unknown().optional() });
export const contractSchema = z.object({ clientId: id, projectId: id.optional(), contractNumber: z.string().trim().min(1).max(80), serviceName: z.string().trim().min(1).max(200), serviceDescription: optionalText, taxableAmount: money, vatAmount: money, totalAmount: money, notes: optionalText });
export const paymentSchema = z.object({ contractId: id, clientId: id, taxableAmount: money, vatAmount: money, totalAmount: money, method: optionalText, dueDate: date.optional(), collectedAt: date.optional(), notes: optionalText });
export const aiRunSchema = z.object({ agentCode: z.string().trim().min(1).max(120), input: z.unknown() });
export const aiOutputApprovalSchema = z.object({ id });

export const internalUserSchema = z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email().transform((v) => v.toLowerCase()), role: z.enum(['admin','direzione','commerciale','consulente','revisore','backoffice','amministrazione','collaboratore_limitato']), password: z.string().min(10).max(200), active: z.coerce.boolean().optional() });
export const userRoleSchema = z.object({ userId: id, role: z.enum(['admin','direzione','commerciale','consulente','revisore','backoffice','amministrazione','collaboratore_limitato']) });
export const userIdSchema = z.object({ userId: id });
