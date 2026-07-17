# ADR-0001: workflow Audit AI Bancabilità v1.1

- **Stato:** approvato
- **Data:** 2026-07-17
- **Ambito:** AI Orchestrator MVP v1, vertical slice Audit AI Bancabilità
- **Decisione precedente:** `FAI-AUDIT-WORKFLOW@1.0`
- **Decisione corrente:** `FAI-AUDIT-WORKFLOW@1.1`

## Contesto

Il CRM deve diventare il sistema di governo dell'ecosistema AI FAI. La prima vertical slice porta l'Audit AI Bancabilità da `CREATED` a `HUMAN_APPROVAL`; approvazione e rilascio restano azioni umane distinte. La state machine è l'unico percorso autorizzato per mutare lo stato del workflow.

La specifica eseguibile `FAI-AUDIT-WORKFLOW@1.0` dichiara 16 stati e 23 transizioni, ma mescola cambi di stato del caso e job degli agenti. Non può quindi essere implementata letteralmente senza introdurre stati irraggiungibili o transizioni concorrenti incompatibili.

### Anomalie oggettive della v1.0

1. `NEEDS_CLARIFICATION`, `SUPERSEDED` e `DELETION_PENDING` sono dichiarati, ma non sono raggiungibili da alcuna transizione.
2. WF-009, WF-010 e WF-011 partono tutte da `READY_FOR_ANALYSIS` e arrivano ad `AI_DRAFT`. Dopo la prima transizione lo stato non è più `READY_FOR_ANALYSIS`, perciò le altre due fallirebbero con un disallineamento di stato.
3. Il limite di due cicli di correzione prescrive un'escalation umana, ma la v1.0 non definisce una transizione applicabile per quel caso.
4. Alcuni failure state dei quality gate non hanno una transizione corrispondente nella macchina.
5. I test della specifica non coprono positivamente e negativamente tutte le 23 transizioni.
6. WF-003 e WF-023 risultano `PENDING_PCO_APPROVAL`; fino all'approvazione della policy non autorizzano l'uso di dati cliente reali.

Questi punti sono una correzione del contratto, non una reinterpretazione silenziosa. Per questo la versione viene incrementata a `1.1` e il suo hash di definizione deve essere conservato con ogni istanza.

## Decisione

Adottiamo `FAI-AUDIT-WORKFLOW@1.1` con:

- 16 stati canonici e 23 transizioni deterministiche;
- job e risultati degli agenti separati dalle transizioni di stato;
- fan-out dei job indipendenti e un solo fan-in che autorizza la transizione successiva;
- massimo due cicli funzionali di correzione, poi escalation operativa umana senza bypass della macchina;
- arresto automatico obbligatorio a `HUMAN_APPROVAL` nella prima vertical slice;
- transizioni successive definite nel contratto, ma invocabili soltanto da comandi umani autorizzati;
- `APPROVED -> RELEASED` sempre manuale: nessun agente o worker può rilasciare un deliverable.

I nomi generici del Master Blueprint, per esempio `NEW`, `REVIEW` e `HUMAN_GATE`, restano concetti di riferimento. Nel database dell'Audit si persistono esclusivamente gli stati canonici seguenti.

## Stati canonici

| Stato | Significato operativo |
|---|---|
| `CREATED` | Fascicolo creato, non avviato. |
| `WAITING_FOR_PAYMENT` | Contratto, ordine o pagamento da verificare. |
| `WAITING_FOR_AUTHORITY` | Identità, poteri, finalità e titolo da verificare. |
| `NEEDS_DOCUMENTS` | Documenti core o chiarimenti documentali mancanti. |
| `DATA_VALIDATION` | Integrità, classificazione, estrazione ed evidenze in controllo. |
| `READY_FOR_ANALYSIS` | Dataset verificato e pronto per i job analitici. |
| `AI_DRAFT` | Artefatti analitici e report in bozza. |
| `INDEPENDENT_REVIEW` | Review indipendenti in corso. |
| `NEEDS_CORRECTION` | È richiesta una nuova versione create-only. |
| `NEEDS_CLARIFICATION` | Un conflitto materiale blocca l'analisi. |
| `HUMAN_APPROVAL` | Pacchetto immutabile in attesa di decisione nominativa. |
| `APPROVED` | Versione approvata, non ancora rilasciata. |
| `RELEASED` | Deliverable rilasciato manualmente con evidenza. |
| `SUPERSEDED` | Versione approvata sostituita; stato terminale. |
| `CLOSED` | Caso rilasciato e chiuso operativamente. |
| `DELETION_PENDING` | Retention scaduta o cancellazione in attesa di controllo; stato terminale. |

## Matrice delle 23 transizioni

I codici WF identificano la semantica della versione `1.1`. Non devono essere interpretati usando la descrizione omonima della v1.0.

| Codice | Evento | Da | A | Condizione o risultato richiesto |
|---|---|---|---|---|
| WF-001 | `CASE_STARTED` | `CREATED` | `WAITING_FOR_PAYMENT` | Avvio del caso. |
| WF-002 | `PAYMENT_VERIFIED` | `WAITING_FOR_PAYMENT` | `WAITING_FOR_AUTHORITY` | Pagamento e contratto verificati. |
| WF-003 | `AUTHORITY_VERIFIED` | `WAITING_FOR_AUTHORITY` | `NEEDS_DOCUMENTS` | Autorità e perimetro verificati; policy applicabile approvata. |
| WF-004 | `CHECKLIST_RESOLVED` | `NEEDS_DOCUMENTS` | `DATA_VALIDATION` | Documenti core completi e conditional risolti. |
| WF-005 | `DOCUMENT_INGESTED` | `DATA_VALIDATION` | `DATA_VALIDATION` | Ingest tecnico completato. |
| WF-006 | `DOCUMENT_CLASSIFIED` | `DATA_VALIDATION` | `DATA_VALIDATION` | Classificazione completata. |
| WF-007 | `EVIDENCE_EXTRACTED` | `DATA_VALIDATION` | `DATA_VALIDATION` | Estrazione con ancoraggi completata. |
| WF-008 | `BLOCKING_CONFLICT_DETECTED` | `DATA_VALIDATION` | `NEEDS_CLARIFICATION` | Conflitto materiale bloccante rilevato. |
| WF-009 | `CLARIFICATION_RESOLVED` | `NEEDS_CLARIFICATION` | `DATA_VALIDATION` | Chiarimento risolto e verificabile. |
| WF-010 | `DATASET_READY` | `DATA_VALIDATION` | `READY_FOR_ANALYSIS` | Dataset validato, coerente e completo. |
| WF-011 | `ANALYSIS_BUNDLE_COMPLETED` | `READY_FOR_ANALYSIS` | `AI_DRAFT` | Fan-in dei job Financial, Credit e Calculation superato. |
| WF-012 | `FINDINGS_DRAFTED` | `AI_DRAFT` | `AI_DRAFT` | Finding e action item in bozza prodotti. |
| WF-013 | `REPORT_DRAFTED` | `AI_DRAFT` | `INDEPENDENT_REVIEW` | Report versionato composto con fonti, limiti e disclaimer. |
| WF-014 | `REVIEW_BUNDLE_COMPLETED` | `INDEPENDENT_REVIEW` | `INDEPENDENT_REVIEW` | Fan-in Schema, Numeric, Source e Red Team completato. |
| WF-015 | `CORRECTION_OPENED` | `INDEPENDENT_REVIEW` | `NEEDS_CORRECTION` | Esistono finding Critical/Major o gate non superati. |
| WF-016 | `CORRECTION_COMPLETED` | `NEEDS_CORRECTION` | `INDEPENDENT_REVIEW` | Nuova versione collegata ai finding pronta per le review. |
| WF-017 | `REVIEW_GATE_PASSED` | `INDEPENDENT_REVIEW` | `HUMAN_APPROVAL` | Tutti i gate superati e zero Critical/Major aperti. |
| WF-018 | `REPORT_APPROVED` | `HUMAN_APPROVAL` | `APPROVED` | Approvazione umana nominativa su versione e checksum esatti. |
| WF-019 | `APPROVAL_CHANGES_REQUESTED` | `HUMAN_APPROVAL` | `NEEDS_CORRECTION` | L'approvatore richiede modifiche motivate. |
| WF-020 | `DELIVERABLE_RELEASED` | `APPROVED` | `RELEASED` | Rilascio manuale con controllo destinatario, file, checksum e canale. |
| WF-021 | `VERSION_SUPERSEDED` | `APPROVED` | `SUPERSEDED` | Versione approvata sostituita con motivazione. |
| WF-022 | `CASE_CLOSED` | `RELEASED` | `CLOSED` | Consegna registrata e condizioni di chiusura soddisfatte. |
| WF-023 | `DELETION_REQUESTED` | `CLOSED` | `DELETION_PENDING` | Retention scaduta, senza legal hold, dopo controllo autorizzato. |

Anche una self-transition valida incrementa sequenza e versione dello stato e produce un record di transizione. Una ripetizione idempotente dello stesso comando restituisce invece il risultato già registrato senza incrementi e senza un secondo evento audit.

## Job, gate e transizioni

Un job descrive lavoro da eseguire; una transizione descrive un cambiamento autorizzato del caso. I due concetti non sono intercambiabili.

- Financial, Credit e Calculation sono job separati. Il completamento di un singolo job non sposta l'istanza ad `AI_DRAFT`; WF-011 è ammessa solo dopo il fan-in e la verifica di tutti i risultati richiesti.
- Schema, Numeric, Source e Red Team sono review separate e indipendenti dall'autore. WF-014 registra il fan-in; WF-015 o WF-017 applicano poi l'esito dei gate.
- Retry tecnici di un job non sono transizioni e non aumentano il ciclo di correzione.
- Il ciclo di correzione aumenta su WF-015 e WF-019. Dopo due cicli non si applica una transizione inventata: si apre un'escalation operativa e il caso resta bloccato nello stato corrente finché una decisione umana autorizzata non produce un comando valido.
- Nessun job scrive direttamente `currentState`; tutti i cambi di stato passano dal motore centrale.

La coda persistente, i job, i tentativi e il worker separato appartengono alle PR successive. La State Machine Foundation non esegue agenti.

## Autorità e fail-closed

La definizione in codice e la matrice versionata sono l'unica autorità sulle coppie `from`/`to`. Per ogni richiesta il motore verifica almeno workflow/versione, stato atteso, versione attesa, transition code, `actorKind` e precondizioni dichiarate. I soli actor kind ammessi sono `HUMAN`, `AGENT` e `SYSTEM`, ciascuno con il proprio contesto identificativo esclusivo. Valori sconosciuti, dati mancanti, definizione/hash incoerente o gate non esplicitamente superato producono un diniego senza mutazione.

L'MVP conserva `dispatchEnabled=false`, `syntheticDataOnly=true` e provider `mock` nel setting globale. L'assenza o l'incoerenza del setting equivale a disabilitato. Nella PR 1 non esiste alcun worker o percorso di dispatch. Il futuro gate ambiente `AI_ORCHESTRATOR_WORKER_ENABLED` è previsto per la PR del worker e non viene introdotto da questa decisione.

I campi di collegamento al contesto CRM sono riservati ma obbligatoriamente `NULL` in questa versione. `automaticDispatchAllowed` resta sempre falso. WF-018..020 sono presenti per chiudere il contratto di ciclo di vita, ma non sono una capacità operativa: artefatti, checksum, snapshot del ruolo, handler autenticati e capability del worker saranno introdotti e verificati prima di qualsiasi esposizione.

I provider esterni restano governati dall'AI Control Plane esistente e devono rimanere disabilitati. La state machine non indebolisce doppio kill switch, allowlist, RBAC/ABAC o revisione umana.

## Conseguenze

### Benefici

- Ogni stato è raggiungibile attraverso una transizione dichiarata.
- I job concorrenti non competono per la stessa transizione.
- Versione e hash impediscono di confondere contratti v1.0 e v1.1.
- Idempotenza e controllo ottimistico rendono esplicito il comportamento sotto concorrenza.
- Il rilascio resta separato da generazione, review e approvazione.

### Costi e vincoli

- Il fan-in richiede risultati e gate persistenti nelle PR successive.
- Le istanze non possono cambiare versione di workflow implicitamente; un'eventuale migrazione richiede una decisione e una procedura dedicate.
- Le transizioni manuali successive a `HUMAN_APPROVAL` sono parte del contratto, ma la prima vertical slice non fornisce automazioni per eseguirle.

## Alternative rifiutate

- **Implementare letteralmente la v1.0:** lascia anomalie eseguibili e agenti concorrenti incompatibili.
- **Trattare ogni job come stato:** moltiplica gli stati tecnici e lega il dominio al piano di esecuzione.
- **Consentire scritture dirette allo stato:** elimina una singola autorità, rende incompleti audit e guard e facilita bypass.
- **Aggiungere microservizi subito:** non necessario per la prima slice; il modular monolith con worker separato resta la decisione architetturale vigente.

## Riferimenti

- [State Machine Foundation](../ai-orchestrator-state-machine-foundation.md)
- [AI Control Plane v1](../ai-control-plane.md)
- [Produzione CRM FAI](../PRODUCTION.md)
