import { PrismaClient, RoleCode } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const prisma = new PrismaClient();
const agents = ['agente_raccolta_dati','agente_anagrafica_azienda','agente_bancabilita','agente_finanza_agevolata','agente_cumulabilita','agente_commerciale','agente_dossier','agente_revisore','agente_checklist_documentale'];

async function main() {
  for (const role of Object.values(RoleCode)) {
    await prisma.activityLog.create({ data: { action: 'seed_role', entityType: 'role', entityId: role } });
  }

  const admin = await prisma.user.upsert({ where: { email: 'admin@fai.local' }, update: {}, create: { email: 'admin@fai.local', name: 'Admin FAI', role: 'admin', passwordHash: await bcrypt.hash('ChangeMe123!', 12) } });
  const consultant = await prisma.user.upsert({ where: { email: 'consulente@fai.local' }, update: { active: true }, create: { email: 'consulente@fai.local', name: 'Consulente FAI Demo', role: 'consulente', passwordHash: await bcrypt.hash('ChangeMe123!', 12) } });

  for (const code of agents) {
    await prisma.aiAgent.upsert({ where: { code }, update: {}, create: { code, name: code.replaceAll('_', ' '), promptVersion: 'v1', inputSchema: {}, outputSchema: { requiresHumanReview: true } } });
  }

  const services = [
    ['verifica_ai_essenziale', 'Verifica AI Essenziale', 'Screening interno preliminare con output AI in bozza da revisionare.', 'ai'],
    ['audit_ai_bancabilita', 'Audit AI Bancabilità', 'Analisi tecnica interna della bancabilità e delle criticità documentali.', 'bancabilita'],
    ['pre_analisi_ai_ammissibilita', 'Pre-Analisi AI Ammissibilità', 'Pre-analisi interna di coerenza rispetto a misure e requisiti da verificare.', 'finanza_agevolata'],
    ['supporto_finanza_ordinaria', 'Supporto Finanza Ordinaria', 'Supporto tecnico interno su strumenti ordinari ipotizzabili.', 'finanza_ordinaria'],
    ['supporto_finanza_agevolata', 'Supporto Finanza Agevolata', 'Supporto tecnico interno su bandi e misure da verificare.', 'finanza_agevolata'],
  ] as const;
  for (const [code, name, description, category] of services) {
    await prisma.serviceCatalog.upsert({ where: { code }, update: { name, description, category, active: true }, create: { code, name, description, category, displayOrder: services.findIndex((s) => s[0] === code) + 1 } });
  }

  const lead = await prisma.lead.create({ data: { firstName: 'Giulia', lastName: 'Bianchi', phone: '+390301234567', email: 'amministrazione@eventivideo-brescia.example', source: 'demo_seed', region: 'Lombardia', province: 'BS', interest: 'Finanziamento 40-50K per eventi e produzioni video', declaredInvestment: '50000', status: 'cliente_acquisito', commercialStatus: 'demo operativo', notes: 'SRL eventi e produzioni video. Spese: marketing, attrezzature tecniche, eventi, liquidità affitto, furgone. DURC ok dichiarato. CRIF/Centrale Rischi ok dichiarato. Due soci decisori.' } });
  const client = await prisma.client.create({ data: { type: 'societa', displayName: 'Eventi & Video Brescia SRL', leadId: lead.id, status: 'attivo', salesOwnerId: admin.id, consultantId: consultant.id, notes: 'Cliente demo reale: SRL organizzazione eventi e produzioni video, provincia Brescia, richiesta 40-50K, due soci decisori.' } });
  const company = await prisma.company.create({ data: { clientId: client.id, name: 'Eventi & Video Brescia SRL', vatNumber: '01234560981', taxCode: '01234560981', rea: 'BS-123456', pec: 'eventivideobrescia@pec.example', legalAddress: 'Via Demo 12, Brescia', operatingAddress: 'Via Produzioni 5, Brescia', region: 'Lombardia', province: 'Brescia', city: 'Brescia', legalForm: 'SRL', atecoCode: '90.02.09', atecoDescription: 'Altre attività di supporto alle rappresentazioni artistiche', activityStatus: 'attiva', employees: 4, annualRevenue: '180000', durcStatus: 'ok dichiarato', notes: 'DURC ok dichiarato; CRIF/Centrale Rischi ok dichiarato dai soci.' } });
  const socio1 = await prisma.person.create({ data: { firstName: 'Giulia', lastName: 'Bianchi', email: 'giulia.bianchi@example.test', phone: '+393331111111', notes: 'Socia e decisore operativo.' } });
  const socio2 = await prisma.person.create({ data: { firstName: 'Marco', lastName: 'Riva', email: 'marco.riva@example.test', phone: '+393332222222', notes: 'Socio e decisore tecnico.' } });
  await prisma.companyPerson.createMany({ data: [{ companyId: company.id, personId: socio1.id, role: 'socia amministratrice', ownershipPercent: '55' }, { companyId: company.id, personId: socio2.id, role: 'socio decisore tecnico', ownershipPercent: '45' }] });
  const project = await prisma.project.create({ data: { clientId: client.id, companyId: company.id, title: 'Piano liquidità e attrezzature tecniche 2026', description: 'Richiesta 40-50K per marketing, attrezzature tecniche, eventi, liquidità affitto e furgone.', totalInvestment: '50000', requestedAmount: '45000', startTiming: 'entro 60 giorni', region: 'Lombardia', province: 'Brescia', sector: 'eventi e produzioni video', status: 'in_analisi', priority: 'alta', scenarioA: 'Finanza ordinaria con istruttoria documentale completa.', scenarioB: 'Valutazione misure agevolate compatibili se aperte e verificabili.', blockingConditions: 'Verifica documentale di bilanci, estratti conto e posizione debitoria.' } });
  await prisma.projectExpense.createMany({ data: [
    { projectId: project.id, category: 'marketing', description: 'Campagne marketing e acquisizione clienti', amount: '8000', potentiallyEligible: true, priority: 'media' },
    { projectId: project.id, category: 'attrezzature', description: 'Attrezzature tecniche audio/video', amount: '17000', potentiallyEligible: true, priority: 'alta' },
    { projectId: project.id, category: 'eventi', description: 'Costi anticipati per produzione eventi', amount: '9000', potentiallyEligible: true, priority: 'alta' },
    { projectId: project.id, category: 'affitto', description: 'Liquidità per affitto laboratorio/studio', amount: '6000', potentiallyEligible: false, priority: 'media' },
    { projectId: project.id, category: 'mezzi', description: 'Acconto furgone operativo', amount: '10000', potentiallyEligible: true, priority: 'media' },
  ] });

  const auditCatalog = await prisma.serviceCatalog.findUniqueOrThrow({ where: { code: 'audit_ai_bancabilita' } });
  const preCatalog = await prisma.serviceCatalog.findUniqueOrThrow({ where: { code: 'pre_analisi_ai_ammissibilita' } });
  const ordinaryCatalog = await prisma.serviceCatalog.findUniqueOrThrow({ where: { code: 'supporto_finanza_ordinaria' } });
  const contract = await prisma.contract.create({ data: { clientId: client.id, projectId: project.id, contractNumber: `FAI-DEMO-${Date.now()}`, serviceName: 'Audit AI Bancabilità + Pre-Analisi AI Ammissibilità', serviceDescription: 'Incarico demo interno con output AI da revisionare e consegna manuale dopo controllo umano.', taxableAmount: '1200', vatAmount: '264', totalAmount: '1464', status: 'firmato', signedAt: new Date(), notes: 'Contratto demo per fascicolo interno.' } });
  const payment = await prisma.payment.create({ data: { contractId: contract.id, clientId: client.id, taxableAmount: '600', vatAmount: '132', totalAmount: '732', method: 'bonifico', status: 'parziale', dueDate: new Date(Date.now() + 14 * 86400000), notes: 'Acconto demo registrato.' } });
  const service = await prisma.clientService.create({ data: { clientId: client.id, companyId: company.id, projectId: project.id, serviceCatalogId: auditCatalog.id, contractId: contract.id, paymentId: payment.id, status: 'revisione_umana', paymentStatus: 'parziale', assignedToId: consultant.id, dueDate: new Date(Date.now() + 10 * 86400000), internalNotes: 'DURC ok dichiarato, CRIF/Centrale Rischi ok dichiarato. Verificare documenti prima di ogni output consegnabile.' } });
  await prisma.clientService.createMany({ data: [
    { clientId: client.id, companyId: company.id, projectId: project.id, serviceCatalogId: preCatalog.id, contractId: contract.id, paymentId: payment.id, status: 'raccolta_documenti', paymentStatus: 'parziale', assignedToId: consultant.id, internalNotes: 'Pre-analisi su ammissibilità spese e coerenza progetto.' },
    { clientId: client.id, companyId: company.id, projectId: project.id, serviceCatalogId: ordinaryCatalog.id, contractId: contract.id, paymentId: payment.id, status: 'in_lavorazione', paymentStatus: 'parziale', assignedToId: consultant.id, internalNotes: 'Supporto su scenario finanza ordinaria, senza esiti promessi.' },
  ] });
  const demoDir = path.join(process.cwd(), 'storage/private/documents', client.id, service.id);
  await mkdir(demoDir, { recursive: true });
  const crifPath = path.relative(process.cwd(), path.join(demoDir, 'demo-dichiarazione-crif.txt'));
  const visuraPath = path.relative(process.cwd(), path.join(demoDir, 'demo-visura.txt'));
  await writeFile(crifPath, 'File demo development - dichiarazione CRIF/Centrale Rischi. Metadata demo, non documento reale.');
  await writeFile(visuraPath, 'File demo development - visura camerale. Metadata demo, non documento reale.');
  await prisma.document.createMany({ data: [
    { clientId: client.id, companyId: company.id, projectId: project.id, clientServiceId: service.id, serviceArea: 'bancabilita', documentCategory: 'centrale_rischi', type: 'metadata_demo', title: 'Dichiarazione CRIF e Centrale Rischi ok (metadata demo)', fileName: 'demo-dichiarazione-crif.txt', mimeType: 'text/plain', sizeBytes: 91, storagePath: crifPath, uploadedById: admin.id, status: 'da_verificare', visibilityLevel: 'interno', containsSensitiveData: true },
    { clientId: client.id, companyId: company.id, projectId: project.id, clientServiceId: service.id, serviceArea: 'anagrafica', documentCategory: 'visura', type: 'metadata_demo', title: 'Visura camerale demo Eventi & Video Brescia SRL (metadata demo)', fileName: 'demo-visura.txt', mimeType: 'text/plain', sizeBytes: 76, storagePath: visuraPath, uploadedById: admin.id, status: 'classificato', visibilityLevel: 'interno', containsSensitiveData: true },
  ] });
  const agent = await prisma.aiAgent.findUniqueOrThrow({ where: { code: 'agente_bancabilita' } });
  const aiRun = await prisma.aiRun.create({ data: { agentId: agent.id, status: 'completed', createdById: admin.id, input: { cliente: client.displayName, richiesta: '40-50K', provincia: 'Brescia' }, output: { sintesi: 'Bozza interna: dati dichiarati coerenti ma da verificare documentalmente.' } } });
  await prisma.aiOutput.create({ data: { aiRunId: aiRun.id, clientServiceId: service.id, title: 'Bozza Audit AI Bancabilità - Eventi & Video Brescia SRL', content: 'Output interno da revisionare: richiesta 40-50K per marketing, attrezzature, eventi, liquidità affitto e furgone. DURC e CRIF/Centrale Rischi dichiarati ok; servono verifiche documentali e revisione umana.', status: 'needs_review', requiresHumanReview: true, forbiddenPhrases: ['finanziamento garantito','contributo garantito','approvazione sicura','risultato certo'] } });
  await prisma.bankabilityAssessment.create({ data: { clientId: client.id, companyId: company.id, projectId: project.id, declaredCrif: 'ok dichiarato', declaredCentralRisk: 'ok dichiarato', revenue: '180000', monthlyRent: '1200', riskLevel: 'medio', riskRationale: 'Dati positivi dichiarati, documentazione bancaria e fiscale da verificare.', dataCompleteness: 55 } });
  await prisma.corporateFinancingAssessment.create({ data: { clientId: client.id, companyId: company.id, projectId: project.id, clientServiceId: service.id, requestedAmount: '45000', purpose: 'Marketing, attrezzature tecniche, eventi, liquidità affitto, furgone.', timing: 'entro 60 giorni', ordinaryInstruments: 'chirografario, leasing, anticipo fatture o linea di credito da valutare', fundingNeed: '40-50K', dscrCashflow: 'Da calcolare su bilanci/estratti conto', criticalIssues: 'Documenti ancora da verificare', scenarioA: 'Istruttoria ordinaria con documenti completi', scenarioB: 'Riduzione importo o composizione strumenti', nextAction: 'Raccogliere bilanci, estratti conto e preventivi.' } });
  const pre = await prisma.preAnalysis.create({ data: { projectId: project.id, clientId: client.id, companyId: company.id, status: 'da_revisionare', internalSummary: 'Pre-analisi demo su spese e ammissibilità potenziale, senza esiti garantiti.', requiredDocuments: 'Visura, bilanci, dichiarazioni fiscali, preventivi, estratti conto.', nextActions: 'Completare raccolta documentale e revisione consulente.' } });
  await prisma.dossier.create({ data: { preAnalysisId: pre.id, projectId: project.id, clientId: client.id, title: 'Dossier demo Eventi & Video Brescia SRL', type: 'interno', status: 'bozza_ai', markdownContent: 'Bozza interna del dossier. Revisione umana obbligatoria prima di qualsiasi utilizzo esterno.' } });
  await prisma.task.create({ data: { clientId: client.id, companyId: company.id, projectId: project.id, clientServiceId: service.id, title: 'Verificare documenti bancabilità e DURC', description: 'Controllare evidenze su DURC, CRIF/Centrale Rischi, bilanci e preventivi.', type: 'revisione_documentale', priority: 'alta', status: 'aperto', assignedToId: consultant.id, dueAt: new Date(Date.now() + 7 * 86400000), createdById: admin.id } });
  await prisma.auditLog.create({ data: { actorId: admin.id, event: 'seed_demo_fascicolo_cliente', entityType: 'Client', entityId: client.id, after: { cliente: client.displayName, provincia: 'Brescia', richiesta: '40-50K' } } });
}

main().finally(async () => prisma.$disconnect());
