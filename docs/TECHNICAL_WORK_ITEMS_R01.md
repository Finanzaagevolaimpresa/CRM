# Attività, checklist e scadenze nell'incarico tecnico

Questo incremento, basato sul merge PR217 `eb5511fb6c82e15263d6cddf18e7ed36e5100442`, integra i contratti preparatori conservati nei documenti precedenti. La produzione resta schema65 fino a un distinto rilascio autorizzato. Il codice candidato richiede schema66; non è compatibile con un ritorno a un'app che ignori le nuove generazioni o selezioni.

## Comportamento

Nella gestione degli incarichi l'Admin personale sceglie singole attività e voci checklist esistenti, fino a 20, con campi leggibili e modificabili distinti. Le operazioni «Gestire la checklist» e «Gestire le attività e le scadenze» richiedono almeno una selezione pertinente. Titolo, note, descrizione e scadenza non sono impliciti. Nessun elemento futuro, altro progetto o altra pratica viene incluso automaticamente. Il catalogo è limitato ai primi 50 elementi per tipo.

Il tecnico apre l'elemento da «I miei incarichi tecnici». Vede soltanto i campi scelti; prepara il riepilogo prima/dopo e conferma la modifica esatta. Può modificare titolo/note della checklist oppure titolo/descrizione/priorità/scadenza dell'attività, solo se autorizzati singolarmente. Non modifica da qui stato, assegnatario, collegamenti, referente commerciale o documenti. La versione di un documento collegato richiede una scelta documentale separata e tuttora valida. Contratti, pagamenti e metadati finanziari sono esclusi.

Ogni comando è vincolato a persona, sessione, incarico, revisione, selezione e versione corrente. Revoca, scadenza, modifica concorrente o contesto cambiato impediscono la conferma. Una risposta persa si riconcilia mediante la ricevuta dello stesso comando; non si ritenta con un altro identificativo. Recuperare una ricevuta non divulga valori né riapre il record revocato.

## Dati e accesso

Il legame elemento/target è conservato nella selezione della revisione firmata dell'incarico esistente: non viene introdotto un secondo sistema di concessioni. I record canonici restano `Task` e `DocumentChecklistItem`. Le revisioni precedenti senza `workItems` mantengono esattamente il proprio payload firmato e non ereditano nuove operazioni.

La migration `20261024090000_technical_work_items_v1` aggiunge:

- `TechnicalWorkItemGeneration`: versione di contenuto e versione di perimetro per elemento, inizializzate a uno sui record esistenti senza cambiarne i dati o creare incarichi. I trigger coprono anche aggiornamenti ordinari. Il registro è conservato attraverso cancellazione e riuso dell'identità. Cambi di relazioni, lifecycle, stato, documento o classificazione finanziaria invalidano permanentemente la vecchia selezione, anche dopo ripristino.
- `TechnicalWorkItemCommand`: ricevute immutabili, con riferimenti restrittivi all'attore e alla revisione dell'incarico. Il controllo differito impone modifica canonica, incremento della generazione, comando e audit minimizzato nella stessa transazione. Nessun testo precedente o nuovo viene copiato nell'audit.

L'ammissione rilegge sessione, persona, autorità, registro firmato, parentela, elemento, generazioni e documenti sotto lock. La proiezione dei campi e dell'elenco avviene nella stessa transazione del target. I percorsi ordinari conservano le esclusioni dei record già vincolati anche dopo revoca, cambio di selezione o rimozione del collegamento; non sono una via alternativa per leggere campi non concessi.

## Qualifica predisposta

La CI dedicata verifica SQL66 su schema65 immutabile, rifiuto di schema64, rollback completo di un errore prima del commit, conservazione dei dati precedenti e del prefisso65, backfill esatto, comandi vuoti e parità Prisma. Le nuove prove PostgreSQL sono eseguite esclusivamente in CI effimera con nome e marcatore sintetici.

Dieci scenari PostgreSQL coprono due tecnici e due commerciali, selezione dei campi, metadati finanziari, replay esatto, risposta persa, audit, modifica concorrente, revoca e cambi di perimetro ripristinati. Tre scenari browser nativi coprono scelta personale, modifica effettiva di attività e checklist, esclusione degli altri profili, desktop/mobile, perdita di risposta e revoca con anteprima aperta. PR140 verifica gli elementi, le generazioni e le ricevute anche nell'immagine confezionata e dopo riavvio, con gli stessi controlli sulle sessioni.

Il codice e le prove predisposte non costituiscono PASS. La qualifica richiede l'esito completo sull'HEAD finale e un unico riesame pertinente. Lint, typecheck e validazione Prisma locali sono distinti dai controlli PostgreSQL/browser e dal build Linux.

## Recuperabilità e limiti

SQL66 non è autorizzata dal consenso PR217. Prima della produzione occorrono piano esatto, hash SQL, target, impatti, riesame e autorità specifica. Non sono compresi nuovi binding, incarichi, concessioni o invii reali, backup, restore o down-migrate. Il recupero ammesso va qualificato con codice compatibile con schema66 e con i dati correnti; un errore dopo la migration può richiedere l'app ferma fino alla correzione.

Restano separati creazione di nuove attività dal percorso tecnico, transizioni checklist con evidenza documentale, caricamento di file, enti/portali, integrazioni e rendicontazioni. Questo incremento non dichiara concluso l'intero mandato CRM.
