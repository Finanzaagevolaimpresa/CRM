# ADR-0005 — AI Orchestrator Mock Handler Registry Foundation v1

## Stato

Accettato; fondazione presente in `main` dalla PR #78. Il merge non autorizza
deploy o attivazione operativa.

## Contesto

Le fondazioni precedenti definiscono il catalogo dei tredici job, le capability e identità dichiarative degli handler, le primitive runtime dormienti e i contratti result/artifact. Non esiste però ancora una mappa eseguibile, chiusa e verificabile fra quelle identità e implementazioni mock deterministiche.

Collegare direttamente funzioni generiche, adapter AI esistenti, provider o accesso database introdurrebbe una superficie non controllata prima dell'esistenza del worker e del relativo control plane. Accettare input non tipizzati o output arbitrari renderebbe inoltre inefficaci le identità hashate definite finora.

## Decisione

Adottiamo un registry TypeScript v1 puro, versionato e hashato, con una mappa esaustiva `FaiAuditJobCode` → handler per esattamente tredici job. Ogni handler è sincrono, puro, `mock`/`synthetic` e restituisce una fixture costante compatibile con il Result & Artifact Contract v1 del proprio job.

L'invocation è un envelope Zod strict e ricorsivamente chiuso. Il boundary ricalcola il job payload hash e verifica registry, definition, job, capability, handler, executor/config, workflow, invariant causali PR75, planning rule, slot ordinale esatto e result contract prima dell'esecuzione. Il costruttore confronta anche le identità ridondanti dell'intent persistente, inclusi bundle, dedupe key e disponibilità. All'handler arriva una proiezione minima deep-frozen, senza lease, attempt, fencing, servizi o dati applicativi.

Ogni definizione e l'intero registry hanno hash domain-separated. L'identità include fixture, limiti e policy di side effect. L'input schema hash lega field tree, literal/versioni, pattern, enum, identità workflow completa, policy JSON e invariant cross-field; golden vector letterali impediscono modifiche semantiche silenziose sotto `1.0`. Il registry dipende dagli hash delle fondazioni v1 esistenti senza cambiarli; ogni modifica semantica futura richiede una nuova versione.

Il registry applica limiti di 32 KiB all'input e 64 KiB all'output e misura un budget osservato massimo di 5 secondi. La misura avviene fuori dall'handler, non influenza output o hash e causa un rifiuto se risulta superata.

## Confini della decisione

Questa decisione non introduce:

- processo worker, worker thread, child process o ciclo runtime;
- claim, heartbeat, retry, completion, scheduling, timer, cron o dispatch;
- route, UI o control plane;
- accesso a rete, `fetch`, OpenAI o altri provider;
- accesso a dati CRM reali, file system, ambiente o casualità;
- client database, query callback, persistenza o transizioni di workflow;
- `AiRun`, `AiOutput`, modifiche Prisma, migration, seed o backfill.

Le funzioni del registry sono invocabili soltanto in modo esplicito dal codice o dai test; la PR non le collega alla Worker Runtime Foundation. Tutti i gate e le tredici capability restano disabilitati.

## Budget temporale

Il budget v1 non è un hard timeout. Un controllo eseguito nello stesso isolate può misurare la durata dopo il ritorno dell'handler, ma non può interrompere in sicurezza una funzione sincrona bloccata. `Promise.race`, timer o `AbortSignal` non risolvono questo limite e potrebbero creare una falsa garanzia operativa.

Gli handler v1 sono quindi costanti, sincroni, senza I/O e senza loop dipendenti dall'input; dimensioni e shape sono limitate prima dell'invocazione. Un timeout preemptive richiederà isolamento nel futuro processo worker e una decisione separata.

## Invarianti adottati

- Il registry contiene esattamente una definizione e un handler per ciascuno dei tredici job canonici.
- Job, capability, handler, executor/config e result contract devono avere identità coerenti prima dell'esecuzione.
- Provider e data mode sono esclusivamente `mock` e `synthetic`.
- Tutti i permessi di side effect dichiarati dal registry sono `false`.
- Lo stesso input canonico produce lo stesso draft; tempo, retry e ordine delle chiavi non modificano l'output.
- Output asincroni, fixture alterate e draft non validi sono rifiutati.
- L'output viene validato dal contratto specifico del job e restituito deep-frozen.
- Il registry non persiste risultati e non può modificare job, runtime o workflow.
- Il budget temporale è osservato e non viene rappresentato come barriera preemptive.

## Conseguenze

Un futuro worker disporrà di una superficie piccola e auditabile per risolvere ed eseguire handler mock, senza dover interpretare configurazioni dinamiche o ottenere accesso libero al CRM. La separazione mantiene completion, fencing, retry e persistenza nella Worker Runtime Foundation, che dovrà rivalidare il draft prima del commit.

La scelta di fixture costanti non simula ancora una pipeline AI reale né la lineage fra job. È intenzionale: provider, dati reali, source artifact input e hard timeout restano oggetto di PR future, con autorizzazioni e barriere dedicate.

## Sicurezza operativa

La fondazione resta dormiente. Devono restare `stateMachineEnabled=false`, `dispatchEnabled=false`, `syntheticDataOnly=true`, `provider=mock`, `externalProvidersEnabled=false`, `AI_ORCHESTRATOR_WORKER_ENABLED=0` o assente e tutte le capability worker `enabled=false`.

Il merge della PR #78 non autorizza deploy. L'esistenza del registry non autorizza l'avvio di processi, la creazione di unità systemd, l'abilitazione del dispatch o test con dati cliente.

## Rollback

Non essendoci modifiche database, il rollback è esclusivamente applicativo: mantenere i gate chiusi e ripristinare l'immagine precedente. Non eliminare o modificare tabelle, ledger, job, runtime, result o artifact e non eseguire restore del database.
