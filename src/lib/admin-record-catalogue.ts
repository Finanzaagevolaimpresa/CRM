import type { Permission } from './permissions';

export type AdminRecordPolicy = {
  model: string; label: string; group: string; permission: Permission; fields: string[];
  create: boolean; trash: 'soft' | 'leaf' | null; href: string;
  guidance?: string;
};
const item = (model: string, label: string, group: string, permission: Permission, fields: string,
  options: Partial<Pick<AdminRecordPolicy, 'create' | 'trash' | 'href' | 'guidance'>> = {}): AdminRecordPolicy => ({
  model, label, group, permission, fields: fields.split(/\s+/).filter(Boolean), create: false, trash: null, href: '', ...options,
});

/** An explicit business catalogue, never a caller-selected Prisma delegate.
 * Provenance, signatures, receipts, transport and security controls are absent
 * from every editable allowlist. Creation is enabled only for ordinary records. */
export const adminRecordCatalogue = [
  item('Lead', 'Lead · dati commerciali', 'Clienti e anagrafiche', 'lead.write',
    'source leadSource interest declaredInvestment requestedAmount availableBudget commercialStatus notes commercialProposal',
    { href: '/leads/{id}', guidance: 'Contatti, assegnazione, conversione, archivio e cestino sono gestiti nella scheda lead e nella inbox, conservando identità e SLA.' }),
  item('Client', 'Clienti', 'Clienti e anagrafiche', 'client.write', 'displayName type status notes',
    { trash: 'soft', href: '/clients/{id}', guidance: 'Il collegamento di origine al lead rimane una prova della conversione. I responsabili si gestiscono dalla scheda cliente.' }),
  item('Company', 'Aziende', 'Clienti e anagrafiche', 'company.write',
    'clientId name vatNumber taxCode rea pec legalAddress operatingAddress region province city legalForm atecoCode atecoDescription incorporationDate activityStartDate activityStatus employees annualRevenue durcStatus taxRegime notes',
    { create: true, trash: 'soft', href: '/companies/{id}' }),
  item('Person', 'Persone', 'Clienti e anagrafiche', 'company.write', 'firstName lastName email phone taxCode notes',
    { create: true, trash: 'soft', guidance: 'Una persona può avere più collegamenti aziendali. La correzione anagrafica interessa tutti i suoi collegamenti, mostrati nel riepilogo.' }),
  item('CompanyPerson', 'Ruoli delle persone nelle aziende', 'Clienti e anagrafiche', 'company.write', 'companyId personId role ownershipPercent', { create: true, trash: 'leaf' }),
  item('IncorporationSubject', 'Soggetti da costituire', 'Clienti e anagrafiche', 'company.write',
    'promoterClientId hypotheticalLegalForm hypotheticalAteco plannedActivity region province expectedStartDate estimatedInvestment status issues', { create: true, trash: 'soft' }),
  item('Project', 'Progetti', 'Progetti e pratiche', 'project.write',
    'clientId companyId incorporationSubjectId title description totalInvestment requestedAmount startTiming region province sector status priority scenarioA scenarioB blockingConditions',
    { create: true, href: '/projects/{id}', guidance: 'Responsabile, archivio e cestino sono disponibili nella scheda progetto. Le correzioni non registrano prese in carico personali.' }),
  item('ProjectExpense', 'Voci di spesa', 'Progetti e pratiche', 'project.write',
    'projectId category description amount estimated potentiallyEligible eligibilityNotes priority', { create: true, trash: 'leaf' }),
  item('TechnicalPractice', 'Pratiche tecniche', 'Progetti e pratiche', 'technical.write',
    'clientId projectId clientServiceId title practiceType targetEntity targetPortal status priority dueDate submittedAt protocolNumber integrationRequestNote internalNotes clientVisibleStatus nextClientUpdateAt lastClientUpdateAt',
    { create: true, trash: 'soft', href: '/technical-office/practices/{id}', guidance: 'Incarichi e responsabilità restano nelle azioni dedicate della pratica. Una data di presentazione dichiarata non crea una ricevuta di invio.' }),
  item('BankabilityAssessment', 'Valutazioni di bancabilità', 'Analisi e dossier', 'project.write',
    'clientId companyId projectId declaredCrif declaredCentralRisk protestsOrLiens paymentDelays activeLoans taxDebts socialSecurityDebts revenue ebitda netProfit equity estimatedCashflow estimatedDscr monthlyRent existingMonthlyInstalments availableGuarantees riskLevel riskRationale dataCompleteness humanReviewStatus', { create: true }),
  item('CorporateFinancingAssessment', 'Valutazioni finanziamento aziendale', 'Analisi e dossier', 'project.write',
    'clientId companyId projectId clientServiceId requestedAmount purpose timing ordinaryInstruments mortgage unsecuredLoan leasing factoring invoiceAdvance creditLines mcc guarantees fundingNeed sustainableInstallment dscrCashflow existingDebts criticalIssues scenarioA scenarioB nextAction', { create: true }),
  item('GrantAssessment', 'Valutazioni agevolazioni', 'Analisi e dossier', 'project.write', 'projectId summary', { create: true }),
  item('MeasureMatch', 'Misure valutate', 'Analisi e dossier', 'project.write',
    'grantAssessmentId internalMeasureName measureStatus opensAt closesAt expectedResult expectedBenefitAmount expectedBenefitPercent difficulty difficultyRationale eligibleExpenses ineligibleExpenses blockingConditions requiredDocuments sourceStatus officialSourceUrl verificationRequired notes', { create: true }),
  item('CumulabilityAssessment', 'Valutazioni di cumulabilità', 'Analisi e dossier', 'project.write',
    'projectId grantAssessmentId summary legalResult technicalResult deMinimisRisk rnaRisk doubleFundingRisk timingConflicts conclusion humanReviewStatus', { create: true }),
  item('Document', 'Documenti · metadati', 'Documenti e attività', 'document.upload',
    'clientId companyId projectId clientServiceId serviceArea documentCategory type title containsSensitiveData validUntil',
    { trash: 'soft', href: '/documents/{id}/versions', guidance: 'File, checksum, autore e versioni sono prove conservate. Per sostituire il contenuto carica una nuova versione nella scheda documento.' }),
  item('DocumentChecklistItem', 'Checklist documentali', 'Documenti e attività', 'service.write',
    'clientId clientServiceId projectId title notes status documentId active', { create: true, trash: 'soft' }),
  item('Task', 'Attività', 'Documenti e attività', 'service.write',
    'clientId companyId projectId clientServiceId title description type priority status assignedToId dueAt', { create: true, trash: 'soft', href: '/tasks' }),
  item('Deadline', 'Scadenze', 'Documenti e attività', 'service.write', 'title entityType entityId dueAt status', { create: true, trash: 'leaf' }),
  item('DocumentExtraction', 'Estrazioni documentali · revisione', 'Documenti e attività', 'document.upload', 'extractedJson extractedText status',
    { guidance: 'La revisione conserva testo e struttura precedenti nel registro amministrativo; il documento originale rimane invariato.' }),
  item('VisuraAnalysis', 'Analisi visure · revisione', 'Documenti e attività', 'company.write', 'companyId findings humanReviewStatus'),
  item('PreAnalysis', 'Preanalisi', 'Analisi e dossier', 'project.write',
    'projectId clientId companyId internalSummary clientReadySummary scenarioA scenarioB blockingConditions requiredDocuments nextActions commercialRecommendation',
    { href: '/preanalyses/{id}', guidance: 'Le preanalisi già revisionate o approvate si rettificano nella procedura di nuova versione; i relativi autore, approvatore e date non sono modificabili.' }),
  item('Dossier', 'Dossier storici · bozze', 'Analisi e dossier', 'dossier.write', 'preAnalysisId projectId clientId title type markdownContent jsonContent',
    { guidance: 'Solo bozze modificabili. Dossier approvati o consegnati richiedono una rettifica o una nuova versione; esportazioni e prove di consegna restano conservate.' }),
  item('ClientDossier', 'Dossier cliente', 'Analisi e dossier', 'dossier.write', 'clientId clientServiceId projectId title type content',
    { href: '/client-dossiers/{id}', guidance: 'I dossier versionati usano il proprio editor e il ciclo di revisione; questa correzione è riservata alle bozze non versionate.' }),
  item('AiOutput', 'Output AI · revisione del contenuto', 'Analisi e dossier', 'ai.review', 'title content',
    { guidance: 'Correzione delle bozze prima dell’approvazione, con conservazione del testo originario. Non avvia esecuzioni né modifica provider o approvazioni.' }),
  item('Contract', 'Contratti · dati operativi', 'Servizi e amministrazione', 'contract.write',
    'clientId projectId contractNumber serviceName serviceDescription taxableAmount vatAmount totalAmount notes',
    { create: true, href: '/contracts/{id}', guidance: 'La correzione degli importi riguarda contratti non firmati e senza movimenti. Firme e documenti firmati si gestiscono nella scheda; non vengono ricreati dalla correzione.' }),
  item('Payment', 'Pagamenti · dati operativi', 'Servizi e amministrazione', 'payment.write',
    'contractId clientId taxableAmount vatAmount totalAmount method dueDate notes',
    { create: true, href: '/payments/{id}/collection', guidance: 'Importi e collegamenti sono modificabili prima dell’incasso. Gli incassi mantengono evidenza e procedura dedicata; una rettifica non dichiara movimenti finanziari mai avvenuti.' }),
  item('ClientService', 'Servizi acquistati', 'Servizi e amministrazione', 'service.write',
    'clientId companyId projectId practiceType requestedAmount plannedInvestment operationalNotes dueDate internalNotes',
    { trash: 'soft', guidance: 'Acquisto, pagamento, avvio, chiusura e assegnazione restano nelle procedure collegate, con i rispettivi gate e prove.' }),
  item('ServiceCatalog', 'Catalogo servizi', 'Servizi e amministrazione', 'settings.manage',
    'code name description category basePrice active displayOrder', { create: true, href: '/service-catalog' }),
  item('PracticeCommunication', 'Comunicazioni di pratica · bozze', 'Comunicazioni', 'practice_communications.write',
    'technicalPracticeId title content internalNote type channel', { trash: 'soft', guidance: 'Le comunicazioni usate o approvate restano prove storiche. Nessuna modifica invia un messaggio o ne dichiara l’invio.' }),
] as const;

export function adminRecordPolicy(model: string): AdminRecordPolicy {
  const found = adminRecordCatalogue.find(item => item.model === model);
  if (!found) throw new Error('ADMIN_RECORD_UNKNOWN_MODEL');
  return found;
}
export const adminFieldLabels: Record<string, string> = {
  clientId: 'Cliente', companyId: 'Azienda', projectId: 'Progetto', clientServiceId: 'Servizio acquistato',
  promoterClientId: 'Cliente promotore', personId: 'Persona', incorporationSubjectId: 'Soggetto da costituire',
  technicalPracticeId: 'Pratica tecnica', contractId: 'Contratto', paymentId: 'Pagamento', documentId: 'Documento',
  serviceCatalogId: 'Servizio a catalogo', grantAssessmentId: 'Valutazione agevolazioni', preAnalysisId: 'Preanalisi',
  assignedToId: 'Assegnatario', title: 'Titolo', name: 'Denominazione', displayName: 'Denominazione cliente',
  firstName: 'Nome', lastName: 'Cognome', description: 'Descrizione', content: 'Contenuto', type: 'Tipo',
  status: 'Stato', priority: 'Priorità', notes: 'Note', internalNotes: 'Note interne', internalNote: 'Nota interna',
  totalInvestment: 'Investimento complessivo', requestedAmount: 'Importo richiesto', availableBudget: 'Budget disponibile',
  declaredInvestment: 'Investimento dichiarato', amount: 'Importo', taxableAmount: 'Imponibile', vatAmount: 'IVA', totalAmount: 'Totale',
  startTiming: 'Tempi di avvio', region: 'Regione', province: 'Provincia', sector: 'Settore', city: 'Comune',
  scenarioA: 'Scenario A', scenarioB: 'Scenario B', blockingConditions: 'Condizioni bloccanti',
  estimated: 'Importo stimato', potentiallyEligible: 'Potenzialmente ammissibile', eligibilityNotes: 'Note di ammissibilità',
  dueAt: 'Scadenza', dueDate: 'Scadenza', validUntil: 'Valido fino al', category: 'Categoria', active: 'Attivo',
  role: 'Ruolo aziendale', ownershipPercent: 'Quota percentuale', email: 'Email', phone: 'Telefono', pec: 'PEC',
  taxCode: 'Codice fiscale', vatNumber: 'Partita IVA', rea: 'REA', legalAddress: 'Sede legale', operatingAddress: 'Sede operativa',
  legalForm: 'Forma giuridica', atecoCode: 'Codice ATECO', atecoDescription: 'Descrizione ATECO',
  incorporationDate: 'Data costituzione', activityStartDate: 'Inizio attività', activityStatus: 'Stato attività',
  employees: 'Dipendenti', annualRevenue: 'Fatturato annuo', durcStatus: 'Stato DURC', taxRegime: 'Regime fiscale',
  source: 'Fonte', leadSource: 'Canale di origine', interest: 'Interesse', commercialStatus: 'Stato commerciale',
  commercialProposal: 'Proposta commerciale', practiceType: 'Tipo pratica', targetEntity: 'Ente destinatario',
  targetPortal: 'Portale destinatario', submittedAt: 'Presentazione dichiarata', protocolNumber: 'Protocollo',
  integrationRequestNote: 'Integrazione richiesta', clientVisibleStatus: 'Avanzamento comunicabile',
  nextClientUpdateAt: 'Prossimo aggiornamento cliente', lastClientUpdateAt: 'Ultimo aggiornamento cliente',
  serviceArea: 'Area del servizio', documentCategory: 'Categoria documentale', containsSensitiveData: 'Contiene dati sensibili',
  contractNumber: 'Numero contratto', serviceName: 'Servizio', serviceDescription: 'Descrizione servizio', method: 'Metodo',
  code: 'Codice', basePrice: 'Prezzo base', displayOrder: 'Ordine visualizzazione', channel: 'Canale',
  humanReviewStatus: 'Stato revisione umana', riskLevel: 'Livello rischio', riskRationale: 'Motivazione rischio', dataCompleteness: 'Completezza dati (%)',
  revenue: 'Ricavi', ebitda: 'EBITDA', netProfit: 'Utile netto', equity: 'Patrimonio netto', estimatedCashflow: 'Flusso di cassa stimato',
  estimatedDscr: 'DSCR stimato', monthlyRent: 'Canone mensile', existingMonthlyInstalments: 'Rate mensili esistenti',
  summary: 'Sintesi', conclusion: 'Conclusione', requiredDocuments: 'Documenti necessari', nextAction: 'Prossima azione',
  internalSummary: 'Sintesi interna', clientReadySummary: 'Sintesi cliente', nextActions: 'Prossime azioni',
  commercialRecommendation: 'Indicazione commerciale', markdownContent: 'Contenuto', jsonContent: 'Dati strutturati',
  extractedText: 'Testo estratto', extractedJson: 'Estrazione strutturata', findings: 'Risultati',
  entityType: 'Tipo scheda collegata', entityId: 'Scheda collegata',
  hypotheticalLegalForm: 'Forma giuridica prevista', hypotheticalAteco: 'Codice ATECO previsto', plannedActivity: 'Attività prevista',
  expectedStartDate: 'Data di avvio prevista', estimatedInvestment: 'Investimento stimato', issues: 'Criticità',
  declaredCrif: 'CRIF dichiarata', declaredCentralRisk: 'Centrale rischi dichiarata', protestsOrLiens: 'Protesti o vincoli',
  paymentDelays: 'Ritardi nei pagamenti', activeLoans: 'Finanziamenti attivi', taxDebts: 'Debiti tributari', socialSecurityDebts: 'Debiti previdenziali',
  availableGuarantees: 'Garanzie disponibili', purpose: 'Finalità', timing: 'Tempistiche', ordinaryInstruments: 'Strumenti ordinari',
  mortgage: 'Mutuo ipotecario', unsecuredLoan: 'Finanziamento chirografario', leasing: 'Leasing', factoring: 'Factoring', invoiceAdvance: 'Anticipo fatture',
  creditLines: 'Linee di credito', mcc: 'Garanzia MCC', guarantees: 'Garanzie', fundingNeed: 'Fabbisogno finanziario',
  sustainableInstallment: 'Rata sostenibile', dscrCashflow: 'DSCR e flusso di cassa', existingDebts: 'Debiti esistenti', criticalIssues: 'Criticità rilevanti',
  internalMeasureName: 'Nome della misura', measureStatus: 'Stato della misura', opensAt: 'Apertura', closesAt: 'Chiusura',
  expectedResult: 'Risultato previsto', expectedBenefitAmount: 'Agevolazione prevista', expectedBenefitPercent: 'Agevolazione prevista (%)',
  difficulty: 'Difficoltà', difficultyRationale: 'Motivazione della difficoltà', eligibleExpenses: 'Spese ammissibili', ineligibleExpenses: 'Spese non ammissibili',
  sourceStatus: 'Stato della fonte', officialSourceUrl: 'Fonte ufficiale', verificationRequired: 'Verifica necessaria',
  legalResult: 'Esito giuridico', technicalResult: 'Esito tecnico', deMinimisRisk: 'Rischio de minimis', rnaRisk: 'Rischio RNA',
  doubleFundingRisk: 'Rischio doppio finanziamento', timingConflicts: 'Conflitti temporali', plannedInvestment: 'Investimento previsto', operationalNotes: 'Note operative',
};
export type AdminField = { name: string; label: string; type: 'text' | 'longtext' | 'number' | 'date' | 'boolean' | 'select' | 'json';
  required: boolean; options?: { value: string; label: string; group?: string }[]; dependsOn?: string; help?: string };
export type AdminRecordForm = { model: string; id: string; version: string; label: string; fields: AdminField[];
  values: Record<string, string>; create: boolean; trash: boolean; deleted: boolean; guidance: string | null; href: string;
  relationships: { label: string; href: string }[]; restoringRevision: string | null;
  history: { id: string; action: string; at: string; reason: string; actor: string; canRestore: boolean }[] };
