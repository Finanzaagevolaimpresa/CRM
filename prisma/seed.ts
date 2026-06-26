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
  await prisma.lead.create({ data: { firstName: 'Mario', lastName: 'Rossi', phone: '+390000000000', email: 'mario.rossi@example.test', source: 'referral', region: 'Lombardia', province: 'MI', interest: 'Nuovo investimento produttivo', declaredInvestment: '120000', status: 'nuovo', commercialStatus: 'da qualificare', notes: 'Dato demo interno.' } });
}
main().finally(async () => prisma.$disconnect());
