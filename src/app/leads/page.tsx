export const dynamic = "force-dynamic";
import Link from "next/link";
import type { LeadPriority, LeadSource, LeadStatus, Prisma } from "@prisma/client";
import { PrimaryButton } from "@/components/actions";
import { createLeadAndRedirect } from "@/lib/form-actions";
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth";

const statuses: LeadStatus[] = ["nuovo","da_contattare","contattato","qualificato","non_qualificato","proposta_da_preparare","proposta_inviata","in_trattativa","vinto","perso","archiviato"];
const sources: LeadSource[] = ["sito","whatsapp","referral","campagna","consulente","manuale","altro"];
const priorities: LeadPriority[] = ["bassa","media","alta","urgente"];
const label = (value: string) => value.replaceAll("_", " ");

export default async function Page({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission("lead.read");
  const params = (await searchParams) ?? {};
  const [clientRows, userRows] = await Promise.all([
    prisma.client.findMany({ where: { deletedAt: null }, select: { id: true, displayName: true } }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, role: true } }),
  ]);
  const where: Prisma.LeadWhereInput = { deletedAt: null };
  if (statuses.includes(params.status as LeadStatus)) where.status = params.status as LeadStatus;
  if (sources.includes(params.fonte as LeadSource)) where.leadSource = params.fonte as LeadSource;
  if (priorities.includes(params.priorita as LeadPriority)) where.priority = params.priorita as LeadPriority;
  if (params.assegnatario) where.assignedToId = params.assegnatario;
  const allItems = await prisma.lead.findMany({ where, orderBy: [{ nextActionDate: "asc" }, { updatedAt: "desc" }] });
  const visibleItems = session.role === "admin" || session.role === "direzione" ? allItems : allItems.filter((x) => !x.assignedToId || x.assignedToId === session.userId);
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const users = new Map(userRows.map((u) => [u.id, u.name]));
  return <div className="space-y-6"><PageHeader title="Pipeline commerciale lead" description="Gestione interna di lead, fonti, priorità, consulenti assegnati, prossime azioni e conversione verso il fascicolo cliente." />
    <Card title="Filtri pipeline"><form className="grid gap-3 md:grid-cols-5"><select name="status" defaultValue={params.status ?? ""} className="rounded-xl border p-3"><option value="">Tutti gli stati</option>{statuses.map((s)=><option key={s} value={s}>{label(s)}</option>)}</select><select name="fonte" defaultValue={params.fonte ?? ""} className="rounded-xl border p-3"><option value="">Tutte le fonti</option>{sources.map((s)=><option key={s} value={s}>{label(s)}</option>)}</select><select name="priorita" defaultValue={params.priorita ?? ""} className="rounded-xl border p-3"><option value="">Tutte le priorità</option>{priorities.map((p)=><option key={p} value={p}>{label(p)}</option>)}</select><select name="assegnatario" defaultValue={params.assegnatario ?? ""} className="rounded-xl border p-3"><option value="">Tutti gli assegnatari</option>{userRows.map((u)=><option key={u.id} value={u.id}>{u.name}</option>)}</select><PrimaryButton type="submit">Filtra</PrimaryButton></form></Card>
    <Card title="Crea lead manuale"><form action={createLeadAndRedirect} className="grid gap-3 md:grid-cols-4"><input className="rounded-xl border p-3" name="companyName" placeholder="Nome / ragione sociale" /><input className="rounded-xl border p-3" name="firstName" placeholder="Nome referente" required /><input className="rounded-xl border p-3" name="lastName" placeholder="Cognome referente" required /><input className="rounded-xl border p-3" name="contactPerson" placeholder="Referente" /><input className="rounded-xl border p-3" name="email" type="email" placeholder="Email" /><input className="rounded-xl border p-3" name="phone" placeholder="Telefono" /><input className="rounded-xl border p-3" name="province" placeholder="Provincia" /><input className="rounded-xl border p-3" name="city" placeholder="Città" /><select name="leadSource" defaultValue="manuale" className="rounded-xl border p-3">{sources.map((s)=><option key={s} value={s}>{label(s)}</option>)}</select><select name="priority" defaultValue="media" className="rounded-xl border p-3">{priorities.map((p)=><option key={p} value={p}>{label(p)}</option>)}</select><input className="rounded-xl border p-3" name="interest" placeholder="Servizio / interesse" /><input className="rounded-xl border p-3" name="requestedAmount" type="number" step="0.01" placeholder="Importo richiesto/stimato" /><select name="assignedToId" defaultValue="" className="rounded-xl border p-3"><option value="">Da assegnare</option>{userRows.map((u)=><option key={u.id} value={u.id}>{u.name}</option>)}</select><input className="rounded-xl border p-3" name="nextActionNote" placeholder="Prossima azione" /><input className="rounded-xl border p-3" name="nextActionDate" type="datetime-local" /><PrimaryButton type="submit">Crea lead</PrimaryButton><textarea className="rounded-xl border p-3 md:col-span-4" name="notes" placeholder="Note commerciali" /></form></Card>
    <Card title="Elenco operativo">{visibleItems.length === 0 ? <EmptyState title="Nessun lead trovato">Modifica i filtri o crea un nuovo lead manuale.</EmptyState> : <Table headers={["Lead","Fonte / priorità","Stato","Prossima azione","Cliente","Tracciabilità","Azione"]} rows={visibleItems.map((x)=>[<span className="font-semibold text-fai-navy" key="n">{x.companyName || `${x.firstName} ${x.lastName}`}<br/><span className="text-xs font-normal text-slate-500">{x.email ?? "—"} · {x.phone ?? "—"}</span></span>, <span key="fp"><StatusBadge status={x.leadSource}/><span className="ml-2"><StatusBadge status={x.priority}/></span></span>, <StatusBadge status={x.status} key="s" />, x.nextActionDate ? `${x.nextActionNote ?? "Azione"} · ${x.nextActionDate.toLocaleDateString("it-IT")}` : (x.nextActionNote ?? "Da pianificare"), x.clientId ? clients.get(x.clientId) ?? "Collegato" : "—", <MetaCell key="m" createdAt={x.createdAt} updatedAt={x.updatedAt} owner={x.assignedToId ? users.get(x.assignedToId) : null} />, <Link className="font-bold text-fai-blue underline" href={`/leads/${x.id}`} key="a">Apri</Link>])} />}</Card>
  </div>;
}
