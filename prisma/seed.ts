import { PrismaClient, RoleCode } from '@prisma/client';
import bcrypt from 'bcryptjs';
const prisma = new PrismaClient();
const agents = ['agente_raccolta_dati','agente_anagrafica_azienda','agente_bancabilita','agente_finanza_agevolata','agente_cumulabilita','agente_commerciale','agente_dossier','agente_revisore','agente_checklist_documentale'];
async function main() {
  for (const role of Object.values(RoleCode)) {
    await prisma.activityLog.create({ data: { action: 'seed_role', entityType: 'role', entityId: role } });
  }
  await prisma.user.upsert({ where: { email: 'admin@fai.local' }, update: {}, create: { email: 'admin@fai.local', name: 'Admin FAI', role: 'admin', passwordHash: await bcrypt.hash('ChangeMe123!', 12) } });
  for (const code of agents) {
    await prisma.aiAgent.upsert({ where: { code }, update: {}, create: { code, name: code.replaceAll('_', ' '), promptVersion: 'v1', inputSchema: {}, outputSchema: { requiresHumanReview: true } } });
  }

  const services = [
    ['verifica_ai_essenziale', 'Verifica AI Essenziale', 'Screening interno preliminare con output AI in bozza da revisionare.', 'ai'],
    ['audit_ai_bancabilita', 'Audit AI Bancabilità', 'Analisi tecnica interna della bancabilità e delle criticità documentali.', 'bancabilita'],
    ['pre_analisi_ai_ammissibilita', 'Pre-Analisi AI Ammissibilità', 'Pre-analisi interna di coerenza rispetto a misure e requisiti da verificare.', 'finanza_agevolata'],
    ['ottimizzazione_progetto', 'Ottimizzazione Progetto', 'Supporto interno per strutturare investimenti, scenari e fabbisogni.', 'progetti'],
    ['consulenza_strategica', 'Consulenza Strategica', 'Consulenza direzionale interna per priorità, rischi e prossime azioni.', 'strategia'],
    ['business_plan_presentazione_bancaria', 'Business Plan / Presentazione Bancaria', 'Predisposizione documenti interni e consegnabili revisionati per interlocutori bancari.', 'finanza_ordinaria'],
    ['dossier_strategico', 'Dossier Strategico', 'Dossier operativo in bozza AI con revisione umana obbligatoria.', 'dossier'],
    ['gestione_pratica_supporto_operativo', 'Gestione pratica / Supporto operativo', 'Coordinamento operativo di documenti, scadenze e avanzamento pratica.', 'operativo'],
    ['supporto_finanza_ordinaria', 'Supporto Finanza Ordinaria', 'Supporto tecnico interno su strumenti ordinari ipotizzabili.', 'finanza_ordinaria'],
    ['supporto_finanza_agevolata', 'Supporto Finanza Agevolata', 'Supporto tecnico interno su bandi e misure da verificare.', 'finanza_agevolata'],
    ['altro_servizio_personalizzato', 'Altro servizio personalizzato', 'Servizio interno configurabile in base all\'incarico.', 'personalizzato'],
  ] as const;
  for (const [code, name, description, category] of services) {
    await prisma.serviceCatalog.upsert({ where: { code }, update: { name, description, category, active: true }, create: { code, name, description, category, displayOrder: services.findIndex((s) => s[0] === code) + 1 } });
  }

  await prisma.lead.create({ data: { firstName: 'Mario', lastName: 'Rossi', phone: '+390000000000', email: 'mario.rossi@example.test', source: 'referral', region: 'Lombardia', province: 'MI', interest: 'Nuovo investimento produttivo', declaredInvestment: '120000', status: 'nuovo', commercialStatus: 'da qualificare', notes: 'Dato demo interno.' } });
}
main().finally(async () => prisma.$disconnect());
