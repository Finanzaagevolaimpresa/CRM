export type PracticeCommunicationTemplateCategory = 'cliente' | 'commerciale' | 'interno';

export type PracticeCommunicationTemplate = {
  id: string;
  name: string;
  category: PracticeCommunicationTemplateCategory;
  suggestedTitle: string;
  suggestedText: string;
  placeholders: string[];
};

export const practiceCommunicationTemplates: PracticeCommunicationTemplate[] = [
  {
    id: 'richiesta-documenti-mancanti',
    name: 'Richiesta documenti mancanti',
    category: 'cliente',
    suggestedTitle: 'Richiesta documentazione per pratica [NOME_PRATICA]',
    suggestedText: 'Gentile [NOME_CLIENTE], per proseguire correttamente con la lavorazione della pratica abbiamo necessità di ricevere la seguente documentazione: [DOCUMENTI_MANCANTI]. Una volta ricevuti i documenti, procederemo con le verifiche operative e con l’aggiornamento del fascicolo.',
    placeholders: ['[NOME_CLIENTE]', '[NOME_PRATICA]', '[DOCUMENTI_MANCANTI]'],
  },
  {
    id: 'sollecito-documenti',
    name: 'Sollecito documenti',
    category: 'cliente',
    suggestedTitle: 'Sollecito documentazione pratica [NOME_PRATICA]',
    suggestedText: 'Gentile [NOME_CLIENTE], le ricordiamo che per proseguire con la lavorazione della pratica [NOME_PRATICA] è ancora necessario ricevere la seguente documentazione: [DOCUMENTI_MANCANTI]. Restiamo a disposizione per eventuali chiarimenti operativi sui documenti richiesti.',
    placeholders: ['[NOME_CLIENTE]', '[NOME_PRATICA]', '[DOCUMENTI_MANCANTI]'],
  },
  {
    id: 'aggiornamento-stato-pratica',
    name: 'Aggiornamento stato pratica',
    category: 'cliente',
    suggestedTitle: 'Aggiornamento operativo pratica [NOME_PRATICA]',
    suggestedText: 'Gentile [NOME_CLIENTE], la informiamo che la pratica [NOME_PRATICA] si trova attualmente nello stato operativo: [STATO_PRATICA]. La prossima attività prevista è: [PROSSIMA_AZIONE]. Seguiranno ulteriori aggiornamenti al completamento delle verifiche interne.',
    placeholders: ['[NOME_CLIENTE]', '[NOME_PRATICA]', '[STATO_PRATICA]', '[PROSSIMA_AZIONE]'],
  },
  {
    id: 'richiesta-integrazione',
    name: 'Richiesta integrazione',
    category: 'cliente',
    suggestedTitle: 'Richiesta integrazione pratica [NOME_PRATICA]',
    suggestedText: 'Gentile [NOME_CLIENTE], durante le verifiche operative sulla pratica [NOME_PRATICA] è emersa la necessità di integrare alcune informazioni o documenti: [DOCUMENTI_MANCANTI]. Dopo la ricezione dell’integrazione procederemo con l’aggiornamento del fascicolo e con le successive verifiche.',
    placeholders: ['[NOME_CLIENTE]', '[NOME_PRATICA]', '[DOCUMENTI_MANCANTI]'],
  },
  {
    id: 'comunicazione-commerciale-neutra',
    name: 'Comunicazione commerciale neutra',
    category: 'commerciale',
    suggestedTitle: 'Aggiornamento commerciale su pratica [NOME_PRATICA]',
    suggestedText: 'Aggiornamento per il referente commerciale: la pratica [NOME_PRATICA] risulta nello stato operativo [STATO_PRATICA]. Prima di condividere informazioni con il cliente, attenersi allo stato comunicabile verificato e non anticipare esiti, tempistiche o condizioni non confermate.',
    placeholders: ['[NOME_PRATICA]', '[STATO_PRATICA]'],
  },
  {
    id: 'nota-interna-ufficio-tecnico',
    name: 'Nota interna ufficio tecnico',
    category: 'interno',
    suggestedTitle: 'Nota interna tecnica pratica [NOME_PRATICA]',
    suggestedText: 'Nota interna ufficio tecnico: per la pratica [NOME_PRATICA] verificare lo stato operativo [STATO_PRATICA], la documentazione disponibile e la prossima azione prevista: [PROSSIMA_AZIONE]. Eventuali criticità devono essere annotate nel fascicolo prima di ulteriori comunicazioni esterne.',
    placeholders: ['[NOME_PRATICA]', '[STATO_PRATICA]', '[PROSSIMA_AZIONE]'],
  },
  {
    id: 'pratica-in-avanzamento',
    name: 'Comunicazione pratica in avanzamento',
    category: 'cliente',
    suggestedTitle: 'Pratica [NOME_PRATICA] in avanzamento',
    suggestedText: 'Gentile [NOME_CLIENTE], la pratica [NOME_PRATICA] è in avanzamento operativo. Stiamo completando le verifiche sulla documentazione disponibile e aggiorneremo il fascicolo con le prossime attività: [PROSSIMA_AZIONE].',
    placeholders: ['[NOME_CLIENTE]', '[NOME_PRATICA]', '[PROSSIMA_AZIONE]'],
  },
  {
    id: 'pratica-sospesa-documenti',
    name: 'Comunicazione pratica sospesa per mancanza documenti',
    category: 'cliente',
    suggestedTitle: 'Pratica [NOME_PRATICA] sospesa in attesa documenti',
    suggestedText: 'Gentile [NOME_CLIENTE], la lavorazione della pratica [NOME_PRATICA] è temporaneamente sospesa in attesa della documentazione necessaria: [DOCUMENTI_MANCANTI]. Alla ricezione dei documenti procederemo con le verifiche operative e con il conseguente aggiornamento del fascicolo.',
    placeholders: ['[NOME_CLIENTE]', '[NOME_PRATICA]', '[DOCUMENTI_MANCANTI]'],
  },
];
