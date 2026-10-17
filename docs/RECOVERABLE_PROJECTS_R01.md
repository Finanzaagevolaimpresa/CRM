# Progetti recuperabili — R01

Atto: COORD-DUE-PIANI-CRM-20261016-R01. Base: `6583e918380d0bf658cd675f5e553e7de72c9de5`, schema50. Questo incremento riguarda esclusivamente il lifecycle dei progetti; email ordinario, accessi ulteriori, WhatsApp e bozze Stella hanno candidati e dipendenze distinti.

## Comportamento

Il dettaglio di un progetto operativo presenta **Archivia** e **Sposta nel cestino**. Ogni azione espone le conseguenze e richiede una conferma esplicita. La pagina Progetti contiene gli elenchi **Archivio** e **Cestino**, limitati ai gestori che possiedono già `project.write` e accesso di modifica a quel progetto. Non sono creati permessi o nuovi account.

| Stato | Azione | Risultato |
| --- | --- | --- |
| Operativo | Archivia | `status=archiviato`, `deletedAt=null` |
| Operativo o archivio | Sposta nel cestino | `deletedAt` valorizzato; stato precedente conservato |
| Cestino | Ripristina in archivio | `deletedAt=null`, `status=archiviato`; accessi ancora sospesi |
| Archivio | Riattiva come idea | `status=idea`; ripartenza operativa esplicita |

Il ripristino non riprende implicitamente fasi operative precedenti. La riattivazione come Idea è dichiarata nella conferma; lo stato precedente rimane nell'audit. Titolo, contenuti, importi, responsabili, collegamenti, documenti e versioni non vengono modificati. Non esiste una cancellazione definitiva o cascata in questo flusso.

## Accessi e concorrenza

Archivio e cestino sospendono la consultazione ordinaria e tutte le risorse pertinenti: servizi, pratiche, task, dossier, documenti/versioni, offerte e collegamenti finanziari. Il grafo di esclusione schema50 viene riutilizzato per UI, URL, ricerche, contatori, audit ed esportazioni. Un contratto comune resta escluso senza trascinare nel perimetro i servizi operativi e documenti dell'altro progetto.

Gli elenchi gestionali mostrano soltanto titolo e cliente ai gestori già autorizzati. L'eccezione necessaria per gestire archivio/cestino rimuove esclusivamente le esclusioni di lifecycle, mantenendo tutti i perimetri personali, anche revocati o scaduti. Un destinatario selettivo non può sfruttare il proprio ruolo Admin per ripristinare il progetto o ampliare l'accesso.

La transizione acquisisce la sessione autorevole, i permessi correnti e il lock sul progetto; confronta la versione `updatedAt` esatta e registra stato e audit nella stessa transazione serializzabile. Un errore di audit annulla l'operazione. La scadenza della sessione viene controllata sul clock del database anche prima dell'esito. Doppie richieste e moduli precedenti sono rifiutati; nessun retry automatico di una mutazione con esito incerto.

Le mutazioni delle risorse collegate e le letture di byte trattengono il lock incompatibile con la transizione. Una lettura già autorizzata può completarsi prima dell'archiviazione; le richieste successive devono vedere la sospensione. Non si promette di recuperare dati già visualizzati o scaricati. Le risposte documentali rimangono `private, no-store`.

Ogni evento `project_lifecycle_changed` invalida le concessioni selettive approvate prima dell'evento. Le righe delle concessioni, le prove, le scadenze e le revoche restano immutate. Dopo la riattivazione, una nuova anteprima e la conferma personale dell'autorità già canonica sono necessarie per una nuova concessione. Non vengono inclusi campi, documenti o versioni future. Il pannello di condivisione segnala le concessioni sospese.

## Audit e modello dati

Nessuna nuova migration: si riusano `Project.status`, `Project.deletedAt`, `Project.updatedAt` e l'audit già append-only. La ricevuta conserva `before.status`, `before.deletedAt` e `after.projectId`, `action`, `status`, `deletedAt`, `stateVersion`. Questi campi passano il minimizzatore nativo; le prove PostgreSQL confrontano i valori realmente conservati, non il payload prima del trigger. Nessun contenuto di progetto è copiato nell'audit.

## Qualificazione

- `npm run typecheck`, `npm run lint` e suite di regressione esistente.
- `node --import tsx --test --test-reporter=tap tests/project-lifecycle-db.test.ts`: dieci prove con PostgreSQL effimero marcato dal sentinel. Conservazione delle relazioni, audit nativo, errore di audit, replay, diritti correnti, perimetri indiretti, revoche/scadenze, nuove versioni, download concorrente e scadenza della sessione durante un lock.
- `npx playwright test --config tests/project-lifecycle/playwright.config.ts`: azioni UI reali, conferme, sessioni già aperte, richieste dirette/ricerche/export/download, replay dell'azione e tentativo del destinatario.
- Workflow **Recoverable projects** vincolato all'HEAD esatto e allo schema50 immutato. Le schermate sintetiche sono raccolte negli artefatti della CI.
- Qualificazione immagine PR140 estesa: la stessa immagine, al primo avvio, dopo riavvio e dopo ripresa, deve mantenere archivio/cestino e l'invalidazione delle concessioni dopo un ciclo completo.

I risultati effettivi e l'HEAD qualificato sono riportati nella PR e nel rapporto di consegna. Una prova sintetica non attesta una mutazione o un collaudo su progetti produttivi.

## Recuperabilità e rilascio

La versione PR190 conosce schema50 ma ignora le nuove esclusioni e ricevute di lifecycle: **non è un rollback compatibile**. Si qualifica esclusivamente il riavvio della stessa immagine candidata e, in caso di difetto, una correzione che mantenga gli stessi controlli. Nessun down-migrate e nessun avvio di un binario precedente che ignori le sospensioni.

Il rilascio richiede CI verde sul candidato, PASS del revisore esistente, qualificazione dell'immagine esatta del merge e verifica di sorgente/tree/immagine/schema e health. Non richiede SQL produttivo o prove su progetti reali. Eventuali backup, trasferimenti o accessi a nuovi artefatti soggetti a un blocco hanno un perimetro distinto; le autorizzazioni specifiche della PR190 non vengono riutilizzate.
