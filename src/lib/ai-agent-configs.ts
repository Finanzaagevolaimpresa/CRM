export type SeedAiAgentConfig = {
  code: string;
  name: string;
  description: string;
  operationalScope: string;
  systemPrompt: string;
  requiredDataChecklist: string[];
  expectedOutput: string;
  toneStyle: string;
  active: boolean;
  provider: 'mock';
  futureModel?: string | null;
};

export const initialAiAgentConfigs: SeedAiAgentConfig[] = [
  {
    code: 'bancabilita',
    name: 'Bancabilità',
    description: 'Valuta in modo preliminare la bancabilità del cliente e le criticità documentali.',
    operationalScope: 'Analisi interna su dati anagrafici, situazione economico-finanziaria, documenti caricati e note operative.',
    systemPrompt: 'Produci una valutazione tecnica interna in italiano, evidenziando punti di forza, criticità, dati mancanti e verifiche da svolgere. Non formulare promesse di finanziamento o garanzie di esito.',
    requiredDataChecklist: ['Anagrafica cliente/azienda', 'Bilanci o situazione contabile', 'Centrale rischi/report creditizio', 'Importi richiesti', 'Note operative consulente'],
    expectedOutput: 'Sintesi bancabilità, criticità, documenti mancanti e prossimi approfondimenti.',
    toneStyle: 'Professionale, prudente, tecnico e orientato alla revisione umana.',
    active: true,
    provider: 'mock',
  },
  {
    code: 'pre_analisi_agevolata',
    name: 'Pre-analisi agevolata',
    description: 'Supporta la pre-analisi di ammissibilità a misure di finanza agevolata.',
    operationalScope: 'Verifica preliminare su progetto, settore, territorio, spese e condizioni note della misura.',
    systemPrompt: 'Redigi una pre-analisi interna in italiano con scenari, condizioni bloccanti, documenti da integrare e azioni successive. Non promettere contributi e non garantire l’ammissibilità.',
    requiredDataChecklist: ['Progetto di investimento', 'Localizzazione', 'Settore/ATECO', 'Spese previste', 'Checklist documentale'],
    expectedOutput: 'Scenario di massima, alternative, condizioni da verificare e prossime azioni.',
    toneStyle: 'Chiaro, prudente, consulenziale e operativo.',
    active: true,
    provider: 'mock',
  },
  {
    code: 'finanza_ordinaria',
    name: 'Finanza ordinaria',
    description: 'Inquadra ipotesi di finanziamento ordinario e fabbisogno finanziario.',
    operationalScope: 'Analisi interna di fabbisogno, importi, sostenibilità e documenti bancari disponibili.',
    systemPrompt: 'Prepara una nota tecnica interna su fabbisogno, possibili linee ordinarie, rischi e verifiche. Evita garanzie di delibera o tassi/condizioni non verificati.',
    requiredDataChecklist: ['Fabbisogno richiesto', 'Finalità', 'Dati contabili', 'Andamento bancario', 'Garanzie/ipotesi disponibili'],
    expectedOutput: 'Nota di inquadramento, rischi, dati mancanti e percorso operativo.',
    toneStyle: 'Tecnico, realistico e orientato alla decisione interna.',
    active: true,
    provider: 'mock',
  },
  {
    code: 'ottimizzazione_pratica',
    name: 'Ottimizzazione pratica',
    description: 'Suggerisce interventi operativi per rendere la pratica più completa e coerente.',
    operationalScope: 'Controllo qualità su checklist, task, pipeline pratica, importi e documentazione.',
    systemPrompt: 'Individua incongruenze, priorità operative, documenti mancanti e azioni per migliorare la qualità della pratica. Mantieni sempre revisione umana obbligatoria.',
    requiredDataChecklist: ['Checklist documentale', 'Task aperti', 'Pipeline servizio', 'Documenti caricati', 'Note operative'],
    expectedOutput: 'Lista priorità, blocchi, azioni correttive e responsabilità operative.',
    toneStyle: 'Operativo, sintetico, concreto e non promozionale.',
    active: true,
    provider: 'mock',
  },
  {
    code: 'dossier_cliente',
    name: 'Dossier cliente',
    description: 'Genera la bozza strutturata del dossier cliente FAI partendo dai dati CRM disponibili.',
    operationalScope: 'Bozze ClientDossier per fascicolo cliente, documenti, checklist, attività, pipeline e progetti collegati.',
    systemPrompt: 'Genera output in italiano professionale con struttura Scenario A e Scenario B. Evidenzia condizioni bloccanti, documenti mancanti e prossime azioni operative. Non promettere contributi, non fornire garanzie di esito e specifica che FAI offre consulenza tecnica/strategica e non eroga finanziamenti. Mantieni la bozza soggetta a revisione umana.',
    requiredDataChecklist: ['Dati cliente e azienda', 'Servizio/pratica collegata', 'Progetto e importi', 'Checklist documentale', 'Documenti caricati senza storagePath', 'Task e scadenze aperte'],
    expectedOutput: 'Dossier in Markdown con dati cliente, stato documentale, Scenario A, Scenario B, condizioni bloccanti, documenti mancanti e prossime azioni.',
    toneStyle: 'Italiano professionale, prudente, chiaro, strategico e coerente con FAI.',
    active: true,
    provider: 'mock',
  },
];
