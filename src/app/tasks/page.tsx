export const dynamic = "force-dynamic";
import Link from "next/link";
import { PrimaryButton } from "@/components/actions";
import { completeTask } from "@/lib/form-actions";
import {
  Card,
  EmptyState,
  MetaCell,
  PageHeader,
  StatusBadge,
  Table,
  formatDateTime,
} from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { hasPermission, requirePermission } from "@/lib/auth";
import { canEditTask, canViewTask } from "@/lib/access-control";
import { listAccessibleTasks } from "@/lib/read-access";
export default async function Page() {
  const session = await requirePermission("service.read");
  const [items, clientRows, projectRows, serviceRows, userRows] = await Promise.all([
    listAccessibleTasks(session, { where: { deletedAt: null }, orderBy: { dueAt: "asc" } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.project.findMany({ where: { deletedAt: null } }),
    prisma.clientService.findMany({ where: { deletedAt: null } }),
    prisma.user.findMany({ where: { active: true } }),
  ]);
  const clientById = new Map(clientRows.map((client) => [client.id, client]));
  const projectById = new Map(projectRows.map((project) => [project.id, { ...project, client: clientById.get(project.clientId) ?? null }]));
  const serviceById = new Map(serviceRows.map((service) => [service.id, { ...service, client: clientById.get(service.clientId) ?? null, project: service.projectId ? projectById.get(service.projectId) ?? null : null }]));
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  const users = new Map(userRows.map((u) => [u.id, u.name]));
  const visibleItems = items.filter((task) => canViewTask(session, {
    ...task,
    client: task.clientId ? clientById.get(task.clientId) ?? null : null,
    project: task.projectId ? projectById.get(task.projectId) ?? null : null,
    clientService: task.clientServiceId ? serviceById.get(task.clientServiceId) ?? null : null,
  }));
  return (
    <div className="space-y-6">
      <PageHeader
        title="Attività e scadenze"
        description="Attività interne, priorità, assegnazioni e deadline operative."
      />
      <Card title="Elenco operativo">
        {visibleItems.length === 0 ? (
          <EmptyState title="Nessun elemento presente">
            Non ci sono record da lavorare per questa sezione.
          </EmptyState>
        ) : (
          <Table
            headers={[
              "Attività",
              "Cliente",
              "Priorità",
              "Scadenza",
              "Stato",
              "Tracciabilità",
              "Azione",
            ]}
            rows={visibleItems.map((x) => [
              <span className="font-semibold text-fai-navy" key="n">
                {x.title}
              </span>,
              x.clientId ? (clients.get(x.clientId) ?? "—") : "—",
              x.priority,
              formatDateTime(x.dueAt),
              <StatusBadge status={x.status} key="s" />,
              <MetaCell
                key="m"
                createdAt={x.createdAt}
                updatedAt={x.updatedAt}
                owner={x.assignedToId ? users.get(x.assignedToId) : null}
              />,
              x.completedAt ? (
                "Completato"
              ) : hasPermission(session, "service.write") && canEditTask(session, {
                ...x,
                client: x.clientId ? clientById.get(x.clientId) ?? null : null,
                project: x.projectId ? projectById.get(x.projectId) ?? null : null,
                clientService: x.clientServiceId ? serviceById.get(x.clientServiceId) ?? null : null,
              }) ? (
                <form action={completeTask} key="a">
                  <input type="hidden" name="id" value={x.id} />
                  <PrimaryButton type="submit">Completa</PrimaryButton>
                </form>
              ) : "Sola lettura",
            ])}
          />
        )}
      </Card>
    </div>
  );
}
