# ADR-0004 — AI Orchestrator Result & Artifact Contract Foundation v1

## Stato

Accettato; fondazione presente in `main` dalla PR #77. Il merge non autorizza
deploy o attivazione operativa.

## Contesto

La Worker Runtime Foundation v1 definisce admission, claim, lease, fencing e terminalizzazione, ma non un formato canonico persistibile per l'esito di un job. Accettare payload o hash arbitrari renderebbe impossibile dimostrare che un runtime `SUCCEEDED`, il suo attempt, gli artifact prodotti e l'evento audit descrivano la stessa completion.

Serve inoltre una lineage verificabile per i dati derivati e una semantica causale esplicita per le correzioni, senza introdurre worker, dispatch o provider reali.

## Decisione

Adottiamo un catalogo TypeScript/Zod strict, versionato e hashato, che copre esattamente i 13 job canonici. Ogni contratto vincola risultato, artifact richiesti e loro ordine, schema, capability, handler, executor/config e runtime policy. Il catalogo non diventa un'autorità di scheduling o dispatch.

Gli hash sono calcolati su JSON canonico con separazione di dominio. L'identità del contratto include esplicitamente la lista ordinata degli artifact richiesti. PostgreSQL conserva un mirror indipendente della canonicalizzazione, delle shape v1 strict, delle regole generiche di contenuto e dimensione e delle mappe esatte dei digest di contratto e schema ammessi. Payload, artifact, retention, manifest e risultato vengono ricalcolati anche dal database; non ci si affida a hash forniti dal chiamante.

La completion è una singola transazione serializzabile: rivalida gate, capability, lease e fencing; persiste result, artifact e source reference; marca attempt/runtime `SUCCEEDED`; appende l'evento audit. I constraint trigger differiti verificano l'aggregato completo al commit e causano il rollback di ogni stato parziale o incoerente.

Un retry successivo a una completion già committata è trattato come replay idempotente. La provenienza viene ricostruita dal risultato persistito e il replay è accettato solo se il draft ricalcola lo stesso `resultHash`.

## Invarianti adottati

- Un runtime non `SUCCEEDED` non conserva alcun result; un runtime `SUCCEEDED` ne possiede esattamente uno.
- Runtime, attempt riuscito, result ed evento `SUCCEEDED` condividono identità causale, fencing token, terminalizzazione e `resultHash`.
- Il tipo, l'ordine e la cardinalità degli artifact sono determinati dal job; slot e logical key sono univoci nel risultato.
- `payloadHash`, `artifactHash`, `manifestHash`, `resultHash`, byte totali e retention sono derivati dall'aggregato persistito e verificati al commit.
- Result, artifact e source reference sono append-only e collegati con FK `RESTRICT`.
- I ruoli source sono esclusivamente `PRIMARY`, `SUPPORTING` e `SUPERSEDED`; sono vietati self-reference, cross-workflow e riferimenti non causali.
- Solo `CORRECTION` può creare supersession: il ciclo 1 sostituisce un `REPORT_DRAFT`, i cicli successivi un `CORRECTED_REPORT`, sempre dal ciclo immediatamente precedente e terminale prima del nuovo claim.
- Ogni supersession corrisponde biunivocamente a una source reference `SUPERSEDED` e agli hash dichiarati nel `CORRECTION_MANIFEST`.

## Sicurezza operativa

La decisione è additiva e fail-closed. La migration richiede la barriera DB che mantiene il dispatch disabilitato, rifiuta runtime `SUCCEEDED` preesistenti senza contratto canonico e non effettua backfill.

La fondazione resta dormiente: nessun worker, handler registry eseguibile, route, UI, provider esterno, dispatch, scheduler, accesso CRM reale, `AiRun` o `AiOutput`. Provider e data mode restano vincolati a `mock` e `synthetic`; tutte le capability rimangono disabilitate.

## Conseguenze

La completion futura avrà una superficie più rigida e auditabile, e i bypass SQL più rilevanti falliranno al commit. Ogni modifica futura a schema, policy di canonicalizzazione, limiti o composizione del catalogo richiederà una nuova versione e il corrispondente aggiornamento esplicito del mirror SQL.

Il costo è una maggiore complessità transazionale e di validazione. I risultati prestazionali non vengono assunti: test PostgreSQL 16 sulla migration chain, prove degli invariant, misure su dataset sintetico e smoke Docker devono essere verificati separatamente prima della readiness.

## Rollback

Il rollback applicativo mantiene tutti i gate chiusi, ripristina l'immagine PR76 e lascia intatte le nuove tabelle append-only. Non usare `DROP`, `TRUNCATE`, reset o down migration; un eventuale restore del database è una procedura separata e richiede un'autorizzazione distinta.
