# ADR-0011 — Global AI Manual Authorization & Persistent Admin Notification Gate v1

## Stato

Draft PR85 completa e non operativa. Nessuna esecuzione AI viene attivata da
questa decisione.

## Contesto

Prima della PR85 `ai.run` raggiungeva direttamente i percorsi AI esistenti. Le
notifiche erano soltanto proiezioni calcolate e `AiRun` non era vincolato a una
richiesta approvata né a un’autorizzazione monouso.

## Decisione

Ogni futuro utilizzo AI, incluso il provider `mock`, dovrà essere preceduto da:

1. `AiExecutionRequest` persistente e vincolata al fingerprint degli input;
2. evento iniziale, audit minimizzato e una notifica persistente per ogni Admin
   attivo, creati atomicamente dalla stessa transazione PostgreSQL;
3. `AiExecutionDecision` append-only con attore canonico, motivazione
   minimizzata e hash-chain;
4. `AiExecutionAuthorizationGrant` immutabile, monouso, con scadenza e binding
   completo a richiesta, agente/configurazione, provider, modello e finalità;
5. consumo atomico interno che colleghi un solo nuovo `AiRun` al grant e
   registri `CONSUMED` nello stesso commit.

La richiesta viene rifiutata fisicamente quando non esiste alcun Admin attivo.
Le decisioni `NEEDS_INFORMATION`, `APPROVED`, `REJECTED` e `REVOKED` richiedono
un attore che PostgreSQL rilegge come Admin attivo. L’Admin può approvare una
propria richiesta, ma richiesta e decisione restano azioni distinte.

## Permessi

- tutti i ruoli interni ricevono `ai.execution.request`;
- solo `admin`, mediante il grant globale già esistente, riceve
  `ai.execution.approve`, `ai.execution.reject`, `ai.execution.revoke`,
  `ai.execution.audit`;
- `ai.execution.consume` è un codice interno: nessuna sessione interattiva,
  incluso l’Admin, lo riceve;
- `ai.run` e `ai.external.run` non sono più permessi predefiniti dei ruoli
  non-Admin;
- `ai.approve`, che rilascia un output già revisionato, resta solo Admin;
- un eventuale override storico di `ai.run` o `ai.external.run` non costituisce
  un bypass: nessun ingresso applicativo li usa per creare un run e PostgreSQL
  richiede comunque richiesta e grant.

## Gate applicativo e PostgreSQL

`runClientAiAgent`, quick mock e diagnostica provider:

- calcolano il fingerprint sul body esatto e sulla configurazione immutabile;
- applicano permessi e ABAC;
- persistono soltanto `AiExecutionRequest`;
- non creano `AiRun`, permit, output o dossier;
- non costruiscono né invocano adapter.

La pagina privata `/settings/ai-authorizations` espone coda, storico e dettaglio.
La decisione Admin è sempre una seconda action. Le notifiche persistenti sono
integrate nella pagina Notifiche, nel contatore, nella dashboard e nelle schede
cliente/progetto.

Il trigger `AiRun_authorization_before_insert_v1` blocca ogni nuovo run privo di
binding e verifica richiesta, grant, fingerprint, agente/versione, provider,
modello, contesto, richiedente, idempotenza, scadenza, stato e affidabilità.
L’inserimento valido registra `CONSUMED`; il vincolo deferred richiede
esattamente un run collegato. Binding di run, ledger e grant sono immutabili e
un run autorizzato non può essere cancellato.

Il solo helper interno `reserveAuthorizedAiRun` può riservare il run; non è
importato da route, server action, worker, scheduler o UI. La PR85 non installa
quindi un consumer operativo e l’approvazione non esegue AI. La riserva emette
un capability token opaco monouso, legato a provider, modello e hash dell'input
esatto: adapter mock, adapter OpenAI e diagnostica lo consumano prima di
qualunque elaborazione. La lettura dell'elenco o del dettaglio registra inoltre
`EXPIRED` nel ledger con transazione serializzabile; decisione e consumo
eseguono lo stesso controllo senza dipendere da cron o scheduler.

## Orchestrator

Il contratto `AI_ORCHESTRATOR_MANUAL_AUTHORIZATION_CONTRACT_V1` richiede
binding valido in admission, claim ed esecuzione futuri. L’autorità production
espone sempre `AI_EXECUTION_AUTHORIZATION_REQUIRED` insieme a
`FOUNDATION_LOCKED_V1`; `canAdmit`, `canClaim` e `canAcceptLease` restano
fisicamente falsi.

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

## Rollback

Rollback ordinario: ripristinare l’immagine precedente mantenendo tutti i gate
chiusi e conservando le quattro tabelle, il ledger, le notifiche e gli eventuali
grant. Non usare down migration, `DROP`, `TRUNCATE`, reset, riscrittura del
ledger o cancellazione dei binding. La migration resta additiva e i dati
storici `AiRun` precedenti restano nullable; ogni nuovo inserimento continua a
essere protetto dal trigger finché la migration è presente.
