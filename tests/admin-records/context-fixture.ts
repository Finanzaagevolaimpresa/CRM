import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export async function adminContextFixture(db: PrismaClient) {
  const clients = await Promise.all(['A', 'B'].map(name => db.client.create({ data: {
    displayName: `Cliente contesto sintetico ${name} ${randomUUID()}`, type: 'societa' } })));
  const subjects = await Promise.all(clients.map(client => db.incorporationSubject.create({ data: {
    promoterClientId: client.id, plannedActivity: 'Attività sintetica' } })));
  const projects = await Promise.all(clients.map((client, index) => db.project.create({ data: {
    clientId: client.id, incorporationSubjectId: subjects[index].id, title: `Progetto contesto sintetico ${index}` } })));
  const contract = await db.contract.create({ data: { clientId: clients[0].id, projectId: projects[0].id,
    contractNumber: randomUUID(), serviceName: 'Servizio contesto sintetico', taxableAmount: 100, vatAmount: 22, totalAmount: 122 } });
  const catalog = await db.serviceCatalog.create({ data: { code: 'CTX-' + randomUUID(), name: 'Catalogo contesto sintetico', category: 'test' } });
  const service = await db.clientService.create({ data: { clientId: clients[0].id, projectId: projects[0].id,
    serviceCatalogId: catalog.id, contractId: contract.id } });
  return { clients, subjects, projects, contract, catalog, service };
}

export async function adminContextSnapshot(db: PrismaClient, f: Awaited<ReturnType<typeof adminContextFixture>>) {
  return {
    clients: await db.client.findMany({ where: { id: { in: f.clients.map(row => row.id) } }, orderBy: { id: 'asc' } }),
    subjects: await db.incorporationSubject.findMany({ where: { id: { in: f.subjects.map(row => row.id) } }, orderBy: { id: 'asc' } }),
    projects: await db.project.findMany({ where: { id: { in: f.projects.map(row => row.id) } }, orderBy: { id: 'asc' } }),
    contract: await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } }),
    service: await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } }),
  };
}

export async function adminGraphFixture(db: PrismaClient, actorId: string) {
  const { clients } = await adminContextFixture(db);
  const company = await db.company.create({ data: { clientId: clients[0].id, name: 'Azienda da ricollegare sintetica' } });
  const project = await db.project.create({ data: { clientId: clients[0].id, companyId: company.id, title: 'Progetto del gruppo sintetico' } });
  const task = await db.task.create({ data: { clientId: clients[0].id, companyId: company.id, projectId: project.id, title: 'Attività del gruppo', type: 'manuale' } });
  const expense = await db.projectExpense.create({ data: { projectId: project.id, category: 'software', description: 'Spesa del gruppo', amount: 123 } });
  const document = await db.document.create({ data: { clientId: clients[0].id, companyId: company.id, projectId: project.id,
    type: 'altro', title: 'Documento del gruppo', fileName: 'synthetic.txt', mimeType: 'text/plain', sizeBytes: 10,
    checksum: 'c'.repeat(64), storagePath: 'synthetic/graph-not-read.txt', uploadedById: actorId } });
  const version = await db.documentVersion.create({ data: { documentId: document.id, version: 1, checksum: document.checksum, storagePath: document.storagePath } });
  const deadline = await db.deadline.create({ data: { title: 'Scadenza del gruppo', entityType: 'Task', entityId: task.id, dueAt: new Date(Date.now()+86_400_000) } });
  return { clients, company, project, task, expense, document, version, deadline };
}
