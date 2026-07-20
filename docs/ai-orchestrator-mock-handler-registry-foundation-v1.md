# AI Orchestrator Mock Handler Registry Foundation v1

## Obiettivo e perimetro

Questa fondazione introduce un registry TypeScript interno, canonico, versionato e hashato per i tredici handler `mock` dell'AI Orchestrator. Il registry rende esplicito il legame esatto fra job, capability, handler code/version, executor/config e contratto result/artifact già definiti dalle fondazioni precedenti. Ogni handler produce esclusivamente una fixture JSON sintetica, deterministica e validata dal contratto del proprio job.

La PR resta una fondazione dormiente. Non introduce un processo worker, un ciclo runtime, claim, heartbeat, scheduler, cron, timer operativo, route, UI, dispatch, transizioni di workflow o persistenza degli output. Non modifica il database, lo schema Prisma, le migration o i seed. Non usa rete, `fetch`, OpenAI, provider esterni, file system, variabili ambiente, casualità, dati CRM reali, `AiRun` o `AiOutput` e non espone agli handler un client database o un resolver libero.

La presenza di funzioni handler invocabili nei test non costituisce autorizzazione a collegarle alla Worker Runtime Foundation o ad attivarle in produzione.

## Registry canonico 13/13

Il registry copre esattamente i job canonici, senza fallback o handler dinamici:

- `DOCUMENT_INGESTION` → `DOCUMENT_MANIFEST`;
- `DOCUMENT_CLASSIFICATION` → `DOCUMENT_CLASSIFICATION`;
- `EVIDENCE_EXTRACTION` → `EVIDENCE_SET`;
- `FINANCIAL_ANALYSIS` → `FINANCIAL_ANALYSIS`;
- `CREDIT_ANALYSIS` → `CREDIT_ANALYSIS`;
- `CALCULATIONS` → `CALCULATION_SET`;
- `FINDINGS_DRAFTING` → `FINDINGS_DRAFT`;
- `REPORT_COMPOSITION` → `REPORT_DRAFT`;
- `SCHEMA_REVIEW` → `SCHEMA_REVIEW_REPORT`;
- `NUMERIC_REVIEW` → `NUMERIC_REVIEW_REPORT`;
- `SOURCE_REVIEW` → `SOURCE_REVIEW_REPORT`;
- `RED_TEAM_REVIEW` → `RED_TEAM_REVIEW_REPORT`;
- `CORRECTION` → `CORRECTED_REPORT` seguito da `CORRECTION_MANIFEST`.

La mappa TypeScript è esaustiva rispetto a `FaiAuditJobCode`. Un job sconosciuto, una voce mancante, un duplicato o una divergenza fra job code e handler code falliscono chiusi. Gli handler non sono selezionati da nomi forniti liberamente dal chiamante.

## Identità versionate e hash

Ogni definizione handler lega almeno:

- registry code/version;
- job code/version e `jobDefinitionHash`;
- capability code/version/hash;
- handler code/version;
- executor agent code e config version/hash;
- schema di input code/version/hash;
- result contract code/version/hash;
- hash della fixture sintetica attesa;
- modalità `SYNCHRONOUS_PURE`, strategia di output, limiti e policy senza side effect.

Il `definitionHash` è calcolato su questa identità mediante JSON canonico e separazione di dominio. Il `registryHash` lega, in ordine canonico, tutte le tredici definizioni insieme a job catalog hash, runtime policy hash, result contract catalog hash, schema di input e limiti.

Il registry dipende dagli hash v1 già distribuiti; non modifica retroattivamente job catalog, runtime policy, capability o result contract. Qualunque futura modifica semantica a handler, fixture, limiti, schema o policy richiede una nuova versione e nuovi hash. Il registry non tenta di derivare l'identità dal testo sorgente JavaScript: l'identità di un futuro binario worker resterà una responsabilità separata.

## Input strict e proiezione sicura

L'invocation v1 è un envelope Zod strict. Include soltanto identità tecniche canoniche del registry, handler, executor e job payload persistente v2, con `provider=mock` e `dataMode=synthetic`. Il validatore:

1. applica i limiti JSON e dimensionali prima dell'esecuzione;
2. rifiuta chiavi sconosciute a ogni livello;
3. ricalcola il `jobPayloadHash` sul JSON canonico;
4. verifica registry e definition hash;
5. verifica la parità con job definition, capability, handler, executor/config e result contract;
6. verifica workflow, fase, source transition, invarianti causali PR75, planning rule, ordinalità esatta dello slot, bundle e policy fail-closed del payload;
7. consegna all'handler soltanto una proiezione immutabile e minimizzata.

Il costruttore dell'invocation confronta inoltre tutte le identità ridondanti dell'intent PR75 con il payload autorevole, inclusi catalogo, fase, versione dello stato sorgente, executor, bundle, dedupe key e disponibilità. Lo schema hashato descrive il field tree strict, i literal/versioni, i pattern, gli enum, l'identità completa del workflow, la policy JSON PR77 e gli invariant cross-field; i golden vector bloccano cambi semantici silenziosi sotto la versione `1.0`.

Lease, token, fencing, attempt, segreti, prompt, contenuto documentale e contesto CRM non fanno parte dell'input visibile all'handler. Gli handler non ricevono callback, adapter, client Prisma o altri oggetti che consentano side effect o accesso libero ai dati.

## Esecuzione e output deterministici

I tredici handler sono funzioni sincrone e pure con fixture costanti specifiche per job. Per lo stesso contratto producono lo stesso draft indipendentemente da ora corrente, retry, attempt, worker instance o ordine delle chiavi JSON. Non vengono generati timestamp, UUID o valori casuali.

Prima di restituire un draft, l'esecuzione controllata verifica l'hash della fixture, rifiuta output asincroni o thenable, applica il contratto result/artifact v1 del job e ricontrolla i limiti dimensionali. Il valore restituito è una copia strutturata deep-frozen. L'eventuale `resultHash` definitivo resta responsabilità della completion fenced della Worker Runtime Foundation e include la provenienza persistita; il registry non completa né modifica alcun job.

`CORRECTION` produce in v1 una fixture sintetica senza source reference o supersession. La fondazione non cerca autonomamente artifact precedenti e non interroga il database; una futura integrazione causale dovrà usare una porta di input tipizzata e limitata, separata da questa PR.

## Policy senza side effect

La definizione v1 fissa a `false` accesso di rete, `fetch`, provider call, CRM, database, file system, ambiente, casualità, clock dell'handler, scritture di transizione, scritture runtime e persistenza output. Il registry non offre dependency injection o escape hatch per aggirare tali divieti.

Gli errori sono rappresentati da codici chiusi e non includono il payload negli error message. Mismatch di identità, input non canonico, output non valido o superamento dei limiti causano un rifiuto fail-closed; la PR non converte questi errori in retry e non chiama le primitive runtime.

## Limiti e budget temporale

La policy v1 limita l'invocation canonica a 32 KiB e l'aggregato payload di output a 64 KiB, oltre ai limiti più granulari del Result & Artifact Contract v1. L'esecuzione misura inoltre un budget osservato massimo di 5 secondi mediante un clock monotono esterno all'handler.

Questo controllo è un budget osservato post-esecuzione, non un hard timeout e non può interrompere codice sincrono bloccato nello stesso isolate. `Promise.race`, `setTimeout` o `AbortSignal` non fornirebbero una barriera preemptive affidabile. Un vero hard timeout richiederebbe isolamento in worker thread o processo ed è esplicitamente rinviato alla futura implementazione del worker. Il tempo misurato non entra nell'output o negli hash.

## Stato operativo e verifiche

La Draft PR #78 non autorizza merge, deploy o attivazione. In ogni ambiente operativo devono restare chiusi `stateMachineEnabled=false`, `dispatchEnabled=false`, `syntheticDataOnly=true`, `provider=mock`, `externalProvidersEnabled=false`, `AI_ORCHESTRATOR_WORKER_ENABLED=0` o assente e tutte le capability worker `enabled=false`.

Le verifiche richieste comprendono copertura esatta 13/13, parità di tutte le identità, golden vector degli hash, schema strict, rifiuto di input alterati, determinismo su esecuzioni ripetute, validazione output per tutti i job, limiti, immutabilità e scansioni statiche contro dipendenze o primitive vietate. Test PostgreSQL dedicati e read-only confrontano canonicalizzazione e hash TypeScript/SQL e applicano agli output le funzioni di shape già distribuite con PR76/PR77; confrontano i conteggi prima/dopo per provare l'assenza di scritture. La PR non introduce migration, fixture DB mutative o benchmark SQL.

## Rollback

La fondazione non richiede rollback dati. Un eventuale rollback applicativo futuro consiste nel mantenere tutti i gate chiusi e ripristinare l'immagine precedente. Non eseguire `DROP`, `TRUNCATE`, reset, down migration o restore database per rimuovere il registry TypeScript.
