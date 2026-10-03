export type ProgressAction = { key: string; reason: string; action: string; expected: string };
const steps: Record<string, ProgressAction> = {
  administrative: { key: 'administrative', reason: 'Verifica operativa da completare.', action: 'Richiedi la verifica al responsabile abilitato', expected: 'Prerequisiti verificati dal responsabile.' },
  offer: { key: 'offer', reason: 'Revisione del preventivo da verificare.', action: 'Verifica il preventivo accettato', expected: 'Revisione accettata collegata alla pratica.' },
  signature: { key: 'signature', reason: 'Incarico formalizzato da verificare.', action: 'Completa documento e formalizzazione dell’incarico', expected: 'Versione firmata verificata e collegata alla pratica.' },
  funding: { key: 'funding', reason: 'Accredito iniziale da confermare.', action: 'Verifica e conferma l’accredito', expected: 'Evidenza dell’accredito confermata, senza avvio automatico.' },
  materials: { key: 'materials', reason: 'Documenti o attestazione di completezza da verificare.', action: 'Completa la checklist e verifica le versioni', expected: 'Materiali ammessi, versioni coerenti e completezza attestata.' },
  service: { key: 'service', reason: 'Servizio operativo da collegare.', action: 'Collega il servizio alla pratica', expected: 'Stesso cliente, progetto, contratto e revisione ammessa.' },
  start: { key: 'start', reason: 'Prerequisiti soddisfatti; avvio non ancora registrato.', action: 'Registra l’avvio esplicito', expected: 'Avvio tracciato con autore, data ed evidenze.' },
  dossier: { key: 'dossier', reason: 'Servizio avviato.', action: 'Prepara o aggiorna il dossier', expected: 'Bozza con fonti, date e ipotesi da sottoporre a revisione.' },
  review: { key: 'review', reason: 'Versione corrente da approvare.', action: 'Completa la revisione nominativa', expected: 'Approvazione della versione esatta, conservando lo storico.' },
  delivery: { key: 'delivery', reason: 'Versione corrente approvata.', action: 'Completa la consegna manuale autorizzata', expected: 'Ricevuta riferita alla versione e ai destinatari approvati.' },
  delivered: { key: 'delivered', reason: 'Consegna della versione corrente registrata.', action: 'Consulta la ricevuta e lo storico', expected: 'Versione, autore, data ed esito della consegna verificabili.' },
  verify: { key: 'verify', reason: 'Prerequisito da verificare.', action: 'Apri i dettagli della pratica', expected: 'Motivo del fermo riconciliato prima di proseguire.' },
};

/** Priority is explicit and independent of DB order or the first open task. */
export function nextProgressAction(input: { missing: string[]; started: boolean; canReadContracts: boolean; canReadPayments: boolean;
  dossier?: { currentVersionId: string | null; approvedVersionId: string | null; deliveredVersionIds: string[] } | null }): ProgressAction {
  const missing = input.missing.map(code => ((code === 'incarico_formalizzato' && !input.canReadContracts)
    || (code === 'accredito_iniziale' && !input.canReadPayments)) ? 'VERIFICA_AMMINISTRATIVA' : code);
  {
    if (missing.includes('VERIFICA_AMMINISTRATIVA') || missing.includes('materiale_riservato')) return steps.administrative;
    if (missing.includes('preventivo_accettato')) return steps.offer;
    if (missing.includes('incarico_formalizzato')) return steps.signature;
    if (missing.includes('accredito_iniziale')) return steps.funding;
    if (missing.some(code => code === 'completezza_materiali' || code.startsWith('materiale:') || code.startsWith('motivazione:'))) return steps.materials;
    if (missing.includes('pratica_operativa_collegata')) return steps.service;
    if (missing.length) return steps.verify;
    if (!input.started) return steps.start;
  }
  const dossier = input.dossier;
  if (!dossier?.currentVersionId) return steps.dossier;
  if (dossier.approvedVersionId !== dossier.currentVersionId) return steps.review;
  return dossier.deliveredVersionIds.includes(dossier.currentVersionId) ? steps.delivered : steps.delivery;
}

export function progressTaskType(practiceId: string, actionKey: string) {
  if (!/^[a-f0-9-]{36}$/i.test(practiceId) || !Object.hasOwn(steps, actionKey)) return null;
  // Operational tasks never encode a financial status, even for an Admin planner.
  const operationalKey = ['signature', 'funding'].includes(actionKey) ? 'administrative' : actionKey;
  return `percorso:${practiceId}:${operationalKey}`;
}
export function parseProgressTaskType(value: string | undefined) {
  if (!value) return null;
  const match = /^percorso:([a-f0-9-]{36}):([a-z]+)$/i.exec(value);
  return match ? progressTaskType(match[1], match[2]) : null;
}
export function selectProgressTask<T extends { id: string; type: string | null; status: string; dueAt: Date | null; priority: string }>(tasks: T[], type: string | null) {
  const weight: Record<string, number> = { urgente: 0, alta: 1, media: 2, bassa: 3 };
  return tasks.filter(task => type !== null && task.type === type && !['completata', 'annullata'].includes(task.status))
    .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity)
      || (weight[a.priority] ?? 4) - (weight[b.priority] ?? 4) || a.id.localeCompare(b.id))[0] ?? null;
}
