export type ProfileField = { name: string; label: string; type?: 'email' | 'date' | 'number' | 'textarea'; required?: boolean; max?: number; step?: string };
export const leadProfileFields: ProfileField[] = [
  { name: 'firstName', label: 'Nome' }, { name: 'lastName', label: 'Cognome' },
  { name: 'companyName', label: 'Azienda dichiarata' }, { name: 'contactPerson', label: 'Persona di contatto' },
  { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Telefono', max: 64 },
  { name: 'region', label: 'Regione', max: 100 }, { name: 'province', label: 'Provincia', max: 100 }, { name: 'city', label: 'Comune', max: 100 },
];
export const clientProfileFields: ProfileField[] = [{ name: 'displayName', label: 'Denominazione / nome del cliente', required: true }, { name: 'notes', label: 'Note anagrafiche', type: 'textarea', max: 5000 }];
export const companyProfileFields: ProfileField[] = [
  { name: 'name', label: 'Ragione sociale / denominazione', required: true }, { name: 'vatNumber', label: 'Partita IVA', max: 32 },
  { name: 'taxCode', label: 'Codice fiscale', max: 32 }, { name: 'rea', label: 'Numero REA', max: 64 }, { name: 'pec', label: 'PEC', type: 'email' },
  { name: 'legalForm', label: 'Forma giuridica', max: 100 }, { name: 'legalAddress', label: 'Indirizzo sede legale', max: 500 },
  { name: 'operatingAddress', label: 'Indirizzo sede operativa', max: 500 }, { name: 'region', label: 'Regione', max: 100 },
  { name: 'province', label: 'Provincia', max: 100 }, { name: 'city', label: 'Comune', max: 100 },
  { name: 'atecoCode', label: 'Codice ATECO', max: 32 }, { name: 'atecoDescription', label: 'Descrizione attività ATECO', max: 500 },
  { name: 'incorporationDate', label: 'Data costituzione', type: 'date' }, { name: 'activityStartDate', label: 'Data inizio attività', type: 'date' },
  { name: 'activityStatus', label: 'Stato attività', max: 100 }, { name: 'employees', label: 'Numero dipendenti', type: 'number', step: '1' },
  { name: 'annualRevenue', label: 'Fatturato annuo (€)', type: 'number', step: '0.01' }, { name: 'durcStatus', label: 'Stato DURC', max: 100 },
  { name: 'taxRegime', label: 'Regime fiscale', max: 100 }, { name: 'notes', label: 'Note azienda', type: 'textarea', max: 5000 },
];
export const personProfileFields: ProfileField[] = [
  { name: 'firstName', label: 'Nome', required: true }, { name: 'lastName', label: 'Cognome', required: true },
  { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Telefono', max: 64 },
  { name: 'taxCode', label: 'Codice fiscale', max: 32 }, { name: 'role', label: 'Ruolo (es. titolare, socio, amministratore, referente)', required: true },
  { name: 'ownershipPercent', label: 'Quota di partecipazione (%)', type: 'number', step: '0.01' },
  { name: 'notes', label: 'Note referente', type: 'textarea', max: 5000 },
];
