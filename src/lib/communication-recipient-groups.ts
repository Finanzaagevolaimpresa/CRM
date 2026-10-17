/** Selectors over existing CRM roles, never department mailboxes. */
export const communicationRecipientGroups = {
  commerciali: { label: 'Commerciali', roles: ['commerciale'] },
  tecnico: { label: 'Ufficio tecnico · consulenti e backoffice', roles: ['consulente', 'backoffice'] },
  amministrazione: { label: 'Amministrazione', roles: ['amministrazione'] },
  direzione: { label: 'Direzione', roles: ['direzione'] },
  revisori: { label: 'Revisori', roles: ['revisore'] },
} as const;
