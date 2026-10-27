# Creazione privata di attività e checklist tecniche — R01

## Percorso e decisioni separate

L'Admin titolare dell'autorità personale `technical-assignment`, con `service.write` corrente, apre **Gestisci incarichi tecnici e perimetri → Crea attività o checklist privata** da un progetto o da una pratica operativa. Il caricamento della pagina non scrive dati. Il modulo propone titolo, descrizione, priorità e scadenza per un'attività oppure titolo e note per una checklist. Non permette di impostare destinatari, documenti, assegnatari o uno stato arbitrario.

Il riepilogo e la conferma richiedono la conferma personale di sicurezza ancora valida. Il server rilegge sessione, autorità, permessi e contesto canonico. La conferma salva insieme l'elemento, l'origine firmata, la ricevuta e un audit minimo. La risposta persa si riconcilia dal comando conservato nell'URL: ricaricare non ripete la creazione. Il recupero richiede la medesima sessione e l'autorità corrente; una ricevuta storica non concede accesso.

L'elemento nasce privato. La successiva gestione degli incarichi permette di scegliere separatamente persona, elemento, campi leggibili/modificabili e scadenza. Non vengono create concessioni, notifiche, bozze email o invii impliciti. Un elemento nato per una pratica non compare nel catalogo di una pratica sorella, anche con lo stesso cliente/progetto/servizio; un elemento del progetto non si propaga alle pratiche.

## Isolamento e concorrenza

Il marcatore canonico `technicalPrivate` esclude gli elementi dalle letture ordinarie prima dei limiti e dei conteggi: attività, fascicolo, documenti/checklist, dashboard, notifiche, report, avanzamento e preparazione pratica. Anche le azioni ordinarie di modifica e di assegnazione li rifiutano. Il percorso di lavoro tecnico richiede un incarico corrente con l'elemento e i campi esatti, oltre all'origine firmata e al contesto invariato. L'assenza della tabella o un'origine incoerente produce un diniego.

Le conferme usano una transazione serializzabile con lock su autorità/sessione/contesto; il comando UUID è unico. SQL impedisce un'origine senza il corrispondente elemento/audit nella stessa transazione, la trasformazione di una riga storica in privata, la cancellazione del marcatore, il cambio di origine e la cancellazione definitiva. Il contenuto può avanzare solo attraverso il distinto protocollo di lavoro autorizzato. Il referente commerciale non viene modificato.

## SQL69 candidata e recuperabilità

Migration `20261027010000_technical_private_items_v1`, dalla catena esatta di 68 migrazioni a 69. Aggiunge due colonne booleane inizializzate a `false`, una tabella delle origini inizialmente vuota e controlli atomici. Nessun contenuto storico, collegamento, assegnazione o concessione è riscritto. Il binding in `scripts/technical-private-items/schema-binding.json` identifica base, tree, SQL e schema esatti; i controlli mantengono tutti i precedenti checksum. Il codice di attivazione email riconosce soltanto la nuova catena completa, senza attivare il canale o alterare credenziali e cursori.

Preparazione e prove sono isolate. SQL69, merge e produzione non sono autorizzati da questo documento. Un eventuale piano di rilascio deve identificare candidato, immagine, target, impatti e specifica autorità. Dopo SQL69 il recupero richiede codice compatibile che conservi le esclusioni private: nessun ritorno a codice precedente, down-migrate, nuovo backup o restore viene dedotto. La qualifica PR140 usa il medesimo candidato e confronta origini, marcatori, audit e dati durante arresto/ripresa sintetici.

## Prove riproducibili

- Contratti locali: comando/admission/preview, alterazione delle firme, scadenza, isolamento del target e ricevuta conservata.
- CI PostgreSQL: 13 scenari su creazione senza effetti impliciti, due tecnici e due commerciali, incarico successivo esplicito e modifica reale sintetica, doppio clic, risposta persa, revoche, cambio concorrente del contesto, diniego SQL e rollback dell'audit.
- CI browser nativo: 5 scenari sul modulo effettivo, riepilogo, conferma, assegnazione distinta, lavoro tecnico, revoca a sessione aperta e recupero della risposta persa; schermate desktop/mobile. Solo la perdita di risposta è simulata a livello di trasporto.
- Migration: base errata e replay rifiutati, errore iniettato con rollback di tutti gli oggetti, 68 checksum invariati, confronto di tutti i campi precedenti e drift Prisma invariato.
- Struttura SQL69: osservatore di sola lettura sui metadati, con colonne, indici, vincoli, otto trigger e hash delle tre funzioni. La CI conserva la struttura effettiva da confrontare nel piano di rilascio; non legge contenuti cliente.
- Regressioni: catena completa, accessi/ricerca/report, email, condivisioni e PR140. Le prove sono evidenza solo per l'HEAD su cui vengono eseguite. La presenza del codice di test non equivale a un PASS; gli esiti correnti sono riportati nella PR.

Questo incremento dipende dal catalogo documentale PR226 e conserva il suo perimetro. Non chiude i residui su rendicontazioni, enti/portali, integrazioni esterne o collaudo umano di un incarico reale.
