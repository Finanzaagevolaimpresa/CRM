'use client';

import { useMemo, useState } from 'react';
import { PrimaryButton } from '@/components/actions';
import { uploadDocumentAndRefresh } from '@/lib/form-actions';

type Option = { id: string; label: string; clientId: string };

type DocumentUploadFormProps = {
  clients: Option[];
  companies: Option[];
  projects: Option[];
  services: Option[];
  serviceAreas: string[];
  fixedClientId?: string;
  submitLabel?: string;
  className?: string;
  buttonClassName?: string;
  includeProject?: boolean;
};

export function DocumentUploadForm({ clients, companies, projects, services, serviceAreas, fixedClientId, submitLabel = 'Carica in storage privato', className = 'grid gap-3 md:grid-cols-4', buttonClassName = 'md:col-span-4', includeProject = true }: DocumentUploadFormProps) {
  const [selectedClientId, setSelectedClientId] = useState(fixedClientId ?? '');
  const filteredCompanies = useMemo(() => companies.filter((company) => company.clientId === selectedClientId), [companies, selectedClientId]);
  const filteredProjects = useMemo(() => projects.filter((project) => project.clientId === selectedClientId), [projects, selectedClientId]);
  const filteredServices = useMemo(() => services.filter((service) => service.clientId === selectedClientId), [services, selectedClientId]);
  const relationDisabled = !selectedClientId;

  return <form action={uploadDocumentAndRefresh} className={className}>
    {fixedClientId ? <input type="hidden" name="clientId" value={fixedClientId} /> : <select className="rounded-xl border p-3" name="clientId" required value={selectedClientId} onChange={(event) => setSelectedClientId(event.target.value)}><option value="">Cliente</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.label}</option>)}</select>}
    <select className="rounded-xl border p-3" name="companyId" disabled={relationDisabled}><option value="">Azienda opzionale</option>{filteredCompanies.map((company) => <option key={company.id} value={company.id}>{company.label}</option>)}</select>
    {includeProject ? <select className="rounded-xl border p-3" name="projectId" disabled={relationDisabled}><option value="">Progetto opzionale</option>{filteredProjects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}</select> : null}
    <input className="rounded-xl border p-3" type="file" name="file" required />
    <input className="rounded-xl border p-3" name="title" placeholder="Titolo documento" required />
    <select className="rounded-xl border p-3" name="clientServiceId" disabled={relationDisabled}><option value="">Fascicolo generale</option>{filteredServices.map((service) => <option key={service.id} value={service.id}>{service.label}</option>)}</select>
    <select className="rounded-xl border p-3" name="serviceArea" defaultValue="altro">{serviceAreas.map((area) => <option key={area} value={area}>{area}</option>)}</select>
    <input className="rounded-xl border p-3" name="documentCategory" placeholder="Categoria" defaultValue="altro" />
    <input className="rounded-xl border p-3" name="validUntil" type="date" />
    <label className="flex items-center gap-2 rounded-xl border p-3 text-sm font-bold"><input type="checkbox" name="containsSensitiveData" value="true" /> Sensibile</label>
    <p className="rounded-xl bg-fai-blue/5 p-3 text-sm text-fai-navy md:col-span-4">Seleziona prima il cliente: aziende, progetti e servizi sono filtrati automaticamente e devono appartenere allo stesso fascicolo.</p>
    <PrimaryButton type="submit" className={buttonClassName}>{submitLabel}</PrimaryButton>
  </form>;
}
