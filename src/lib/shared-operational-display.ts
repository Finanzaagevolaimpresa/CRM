// Browser-safe labels. No database, crypto, authorization or server imports.
export const clientOperationalStates = ['da_avviare', 'in_corso', 'in_attesa_cliente', 'in_attesa_ente', 'sospeso_operativo', 'completato'] as const;
export const clientOperationalStateLabels: Record<typeof clientOperationalStates[number], string> = {
  da_avviare: 'Da avviare', in_corso: 'In corso', in_attesa_cliente: 'In attesa del cliente',
  in_attesa_ente: 'In attesa dell’ente', sospeso_operativo: 'Attività sospesa', completato: 'Attività completata',
};
