# ADR-0007 — AI Orchestrator Admin UI Foundation v1

## Stato

Accettato per PR80. Questa decisione non autorizza l'attivazione operativa dell'AI Orchestrator.

## Contesto

La PR79, già unita e distribuita in modalità dormiente, ha introdotto il ledger amministrativo append-only dell'AI Orchestrator. Il contratto distingue policy `desired` e stato `effective`, applica CAS, idempotenza, RBAC dedicato e mantiene l'activation epoch `FOUNDATION_LOCKED_V1` permanentemente fail-closed. Non esiste però ancora una superficie privata e controllata per consultare i 36 target canonici, proporre revisioni desiderate o leggere lo storico con paginazione limitata.

La PR79 applica nel command layer TypeScript una minimizzazione della motivazione più restrittiva del vincolo PostgreSQL originario. Poiché `reason` partecipa agli hash della richiesta e della revisione ed è immutabile, una riga storica incompatibile non può essere corretta o riscritta in place.

## Decisione

Introduciamo una pagina privata server-rendered in `/settings/ai-orchestrator` che usa il Control Plane PR79 senza collegarlo a worker, coda, runtime, handler, dispatch o provider. La pagina rende sempre evidente che la configurazione è desiderata e non operativa, mostra separatamente i gate effettivi e conserva `FOUNDATION_LOCKED_V1` come barriera prevalente.

La UI espone:

- stato effettivo e ragioni di blocco;
- policy globale desiderata;
- 35 scope non globali raggruppati in provider, agenti, capability, job e workflow;
- modifica controllata della policy globale o di un singolo scope;
- emergency stop monotono;
- storico append-only con viste intero ledger, globale/emergenze e scope selezionato, visibile solo con il permesso audit dedicato.

Le operazioni di modifica rimangono scritture sul solo ledger amministrativo. Un valore `desired=true` non apre alcun gate e non diventa una capability operativa.

## Autorizzazione e input

L'accesso alla route e alla navigazione richiede `ai.orchestrator.read`. La UI deriva i moduli disponibili dai permessi effettivi della sessione; il command service rilegge comunque utente attivo, ruolo e override nel database durante la transazione e ricalcola i permessi richiesti dalla differenza di policy.

I form usano schemi strict e accettano soltanto campi esplicitamente previsti. Attore, ruolo, decisioni RBAC, hash canonici, provider, activation epoch, policy version, modalità synthetic-only e dispatch desiderato non sono liberamente forniti dal browser. Le modifiche normali richiedono CAS su versione e revision hash, UUIDv4 come chiave idempotente, reason code, motivazione minimizzata, checkbox e frase esatta di conferma. L'emergency stop resta CAS-less per contratto, ma richiede sessione valida, `ai.orchestrator.kill`, motivazione e conferma forte.

Le modalità desiderate seguono l'ordine di rischio `STOPPED < PAUSED < DRAINING < READY`. Ogni avanzamento richiede `ai.orchestrator.enable`, ogni arretramento richiede `ai.orchestrator.disable`; TypeScript e la funzione PostgreSQL invocata dal trigger applicano la stessa matrice.

Gli esiti mostrati dalla pagina sono codici e messaggi chiusi. Valori rifiutati, stack trace e contenuto integrale degli errori non vengono riflessi nell'URL o nel messaggio utente.

## Minimizzazione della motivazione

Adottiamo un unico schema TypeScript per command, request identity, revision identity e rilettura del ledger. Lo schema limita `reason` a 10–500 code point Unicode e a non più di 500 unità UTF-16, così ogni nuova revisione resta rileggibile anche dal codice PR79. Una nuova migration additiva applica al database lo stesso limite e un vincolo versionato che respinge URL HTTP/HTTPS, tag HTML, `@`, controlli C0/DEL/C1 e termini delimitati associati a password, segreti, token, prompt, authorization, cookie e API key. Le espressioni regolari ASCII usano esplicitamente la collation `C`.

La migration esegue prima un controllo count-only. Se trova anche una sola revisione storica incompatibile, l'intero blocco atomico si arresta senza stampare il contenuto, senza aggiornare righe, senza ricalcolare hash e senza lasciare DDL parziale. Il nuovo vincolo viene aggiunto `NOT VALID` e poi validato; il vincolo PR79 originario resta presente.

Questa barriera riduce il rischio di persistenza accidentale. Non è un classificatore generale e non garantisce, da sola, l'assenza di dati personali o informazioni riservate: l'operatore deve comunque scrivere motivazioni tecniche minimizzate.

## Storico e performance

Lo storico espone filtri chiusi per intero ledger, policy globale incluse le emergenze e singolo scope. Usa paginazione keyset su `createdAt + id`, cursore opaco e versionato legato al filtro, e un limite massimo di 50 revisioni. La query legge una riga aggiuntiva per determinare la pagina successiva e non usa `OFFSET`. Un indice additivo `AiOAdminPolicy_audit_cursor_idx` supporta l'ordinamento globale.

La pagina non usa polling, timer o chiamate browser a servizi esterni. La snapshot corrente viene letta lato server; le motivazioni complete sono proiettate soltanto nella vista storico dopo la verifica di `ai.orchestrator.audit`.

## Errori d'integrità

Se la snapshot del ledger o dei gate non supera la verifica d'integrità, la pagina non esegue query raw alternative e non offre moduli di modifica. Se una pagina audit restituisce un errore d'integrità, le modifiche vengono ugualmente rimosse. Lo stato operativo resta fail-closed.

## Alternative escluse

- aggiornamento diretto di `AiOrchestratorSetting`, `AiControlSetting` o dei kill switch capability;
- editor JSON libero per policy o identità canoniche;
- passaggio di attore, ruolo o permessi tramite form;
- paginazione `OFFSET` dello storico append-only;
- sanificazione o re-hash in place delle motivazioni PR79;
- esposizione della motivazione completa con il solo permesso read;
- polling, API pubblica, worker, scheduler, cron, provider o rete.

## Conseguenze

Gli amministratori autorizzati dispongono di una vista auditabile del contratto desiderato senza ottenere una via di attivazione del runtime. La UI può registrare revisioni desiderate e quindi far crescere legittimamente il ledger e l'audit generico, ma non deve modificare job, outbox, runtime, attempt, result, artifact, `AiRun`, `AiOutput`, workflow o gate operativi.

Una futura attivazione richiederà una nuova ADR, una nuova activation epoch, una PR distinta e un'autorizzazione operativa esplicita. Le revisioni create sotto `FOUNDATION_LOCKED_V1` non potranno essere reinterpretate retroattivamente come autorizzazioni efficaci.

## Rollout e rollback

Il rollout autorizzato deve essere database-first: backup validato, preflight count-only, migration, verifica del vincolo, della funzione RBAC e dell'indice, nuova immagine e smoke autenticato in sola lettura.

Il rollback ordinario è applicativo: ripristinare l'immagine PR79 e lasciare nel database il vincolo additivo, la funzione RBAC più restrittiva, l'indice e le eventuali revisioni append-only già create. Il limite UTF-16 conserva la lettura con PR79; durante il rollback non effettuare mutazioni `PAUSED`/`DRAINING`, mantenere tutti i gate chiusi e usare l'immagine precedente per lettura/health. Non usare down migration, reset, `DROP`, `TRUNCATE`, `UPDATE` o `DELETE` sul ledger. Se il preflight fallisce, la migration si arresta e la release applicativa non deve proseguire.
