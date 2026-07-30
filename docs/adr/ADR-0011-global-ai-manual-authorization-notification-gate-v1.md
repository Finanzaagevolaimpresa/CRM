# ADR-0011 — Global AI Manual Authorization & Persistent Admin Notification Gate v1

## Stato

Draft foundation PR85. Nessuna esecuzione AI viene attivata da questa decisione.

## Contesto

Il CRM consente ancora a `ai.run` di raggiungere direttamente i percorsi AI
esistenti. Le notifiche correnti sono proiezioni calcolate e `AiRun` non è
vincolato a una richiesta approvata né a un’autorizzazione monouso.

## Decisione

Ogni futuro utilizzo AI, incluso il provider `mock`, dovrà essere preceduto da:

1. `AiExecutionRequest` persistente e vincolata al fingerprint degli input;
2. evento iniziale, audit minimizzato e una notifica persistente per ogni Admin
   attivo, creati atomicamente dalla stessa transazione PostgreSQL;
3. `AiExecutionDecision` append-only con attore canonico, motivazione
   minimizzata e hash-chain;
4. `AiExecutionAuthorizationGrant` immutabile, monouso, con scadenza e binding
   completo a richiesta, agente/configurazione, provider, modello e finalità;
5. futuro consumo atomico che colleghi un solo `AiRun` al grant.

La richiesta viene rifiutata fisicamente quando non esiste alcun Admin attivo.
Le decisioni `NEEDS_INFORMATION`, `APPROVED`, `REJECTED` e `REVOKED` richiedono
un attore che PostgreSQL rilegge come Admin attivo. L’Admin può approvare una
propria richiesta, ma richiesta e decisione restano azioni distinte.

## Permessi

- tutti i ruoli interni ricevono `ai.execution.request`;
- solo `admin`, mediante il grant globale già esistente, riceve
  `ai.execution.approve`, `ai.execution.reject`, `ai.execution.revoke`,
  `ai.execution.audit` e `ai.execution.consume`;
- `ai.run` e `ai.external.run` non sono più permessi predefiniti dei ruoli
  non-Admin;
- un eventuale override storico non costituirà un bypass del gate applicativo e
  PostgreSQL previsto nelle fasi successive della PR85.

## Limite della prima foundation

La migration 30 crea il contratto dati, le barriere di integrità, l’evento
iniziale, l’audit e le notifiche. I percorsi applicativi esistenti non sono
ancora collegati al nuovo servizio e nessun grant viene consumato in questa
foundation. Il collegamento di UI, diagnostica, `runClientAiAgent`, Orchestrator
e barriera finale su `AiRun` verrà aggiunto e testato nella stessa Draft PR85.

## Invarianti preservate

- `stateMachineEnabled=false`;
- `dispatchEnabled=false` con constraint fisico validato;
- `syntheticDataOnly=true`;
- provider Orchestrator `mock`;
- `externalProvidersEnabled=false`;
- 13 capability disabilitate;
- `AI_ORCHESTRATOR_WORKER_ENABLED=0`;
- nessun consumer, scheduler, cron, webhook operativo o collegamento reale al
  sito;
- nessun job, run o dato CRM reale creato dalla migration.
