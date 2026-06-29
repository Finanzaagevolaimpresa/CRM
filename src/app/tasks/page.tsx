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
import { requirePermission } from "@/lib/auth";
export default async function Page() {
  const session = await requirePermission("service.read");
  const [items, clientRows, projectRows, userRows] = await Promise.all([
    prisma.task.findMany({ orderBy: { dueAt: "asc" } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.project.findMany({ where: { deletedAt: null } }),
    prisma.user.findMany({ where: { active: true } }),
  ]);
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  const users = new Map(userRows.map((u) => [u.id, u.name]));
  const visibleItems =
    session.role === "admin" ||
    session.role === "direzione" ||
    ["revisore", "backoffice"].includes(session.role)
      ? items
      : items.filter(
          (x) =>
            x.assignedToId === session.userId ||
            x.createdById === session.userId,
        );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Task e scadenze"
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
              "Task",
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
              ) : (
                <form action={completeTask} key="a">
                  <input type="hidden" name="id" value={x.id} />
                  <PrimaryButton type="submit">Completa</PrimaryButton>
                </form>
              ),
            ])}
          />
        )}
      </Card>
    </div>
  );
}
