# Admin: collegamenti, versioni private e profili — candidato locale R01

Mandato: FAI-CRM-ADMIN-MASTER-E-FLUIDITA-20261029-R01, prosecuzione L01–L04 su richiamo diretto.
Baseline conservata: PR245, merge bbc76e18a64b8e3ff75c51fe7d966ae31e5f2fd2, schema73.
Questo documento descrive il candidato locale; non attesta riesame, CI, rilascio o collaudo autenticato in produzione.

| Residuo | Righe della matrice | Percorso candidato | Effetto concreto |
| --- | --- | --- | --- |
| L01 | CORE-007, CORE-015 | Editor Admin Lead/Cliente → Correggi i collegamenti operativi | Anteprima e rettifica reciproca di Lead.clientId e Client.leadId, compresi gli eventuali riferimenti dislocati. Proprietari, conversioni personali e SLA originali restano invariati. |
| L02 | FIN-019, FIN-044 | Editor Admin servizio → Collegamenti; pratica preventivo/avvio → Rettifica contratto, versione firmata e servizio | Riferimenti reali a catalogo, contratto e pagamento. Rettifica dei riferimenti correnti della formalizzazione usando solo un preventivo già accettato e una versione firmata coerente, senza creare accettazioni. |
| L03 | DOC-059 | Cliente → Documenti acquisiti → Carica o ripristina una versione privata | Nuove righe DocumentVersion con byte privati e ricevuta Admin atomica. Riprendere byte precedenti crea un’altra versione; non sovrascrive l’originale. |
| L04 | SET-009 | Impostazioni → Ruoli → Profilo; Account → Applica profilo del ruolo | Profili versionati per i nuovi account; applicazione esplicita a un account esistente. Conserva i limiti nativi finanziari e dei permessi protetti. |

L05 resta invariato: senza prova autorevole dell’esito SMTP non si dichiara NOT_SENT e non si esegue un reinvio.
R04 e lo storico dei rilasci restano separati.

## Collegamenti e formalizzazione

Scegli i riferimenti, prepara l’anteprima e controlla tutte le schede coinvolte. Inserisci la motivazione e conferma.
Il cambiamento è atomico. Una modifica concorrente richiede una nuova anteprima; non viene applicato un distacco parziale.
La cronologia permette di riprendere i collegamenti principali precedenti in una nuova bozza. L’anteprima indica gli effetti attuali: non è un annullamento cieco di tutte le successive modifiche.

Per una formalizzazione già registrata, la rettifica sostituisce i riferimenti operativi correnti. Il registro originario conserva autore, data, firma, accettazione e avvio. I lettori della pratica risolvono la catena delle rettifiche e mostrano il riferimento Admin separato.
Il contratto scelto deve risultare già firmato; cliente, progetto, importi, versione firmata, servizio e pagamento devono essere coerenti.
Una revisione non accettata non viene resa accettata dall’operazione.
Se cambia il preventivo già accettato, la precedente attestazione corrente di completezza viene rimossa dal puntatore operativo; l’evidenza originale rimane conservata.
Nessun nuovo avvio, presa in carico, incasso o invio è attestato dalla rettifica.

## Versioni private

La stessa autorità personale prevista dall’acquisizione originale aggiunge un file oppure seleziona byte precedenti da riprendere. Il percorso non trasferisce l’autorità a un altro Admin per il solo fatto di conoscere l’identificativo del documento.
La versione1, la ricevuta firmata dell’acquisizione e i file precedenti rimangono immutabili.
Ogni versione ha nome, formato, dimensione, SHA256, autore e motivazione distinti.
Il profilo privo di «Caricare documenti» permette di consultare le versioni ammesse, ma mantiene disabilitato il caricamento e il ripristino dei byte.
Apertura e download usano una versione identificata esplicitamente. Il percorso senza parametro conserva la versione originale; non cambia significato dopo un caricamento.
Una nuova versione invalida le selezioni precedenti. Admin deve scegliere nuovamente destinatario, versione e download nel percorso di condivisione o nell’incarico tecnico. Nessun documento viene concesso automaticamente.
Le tutele della classificazione e della fonte finanziaria si applicano anche ai nuovi byte.

## Profili degli account

Il profilo di un ruolo descrive i permessi di partenza per i nuovi account. Il catalogo dei comandi e i limiti nativi restano definiti dall’applicazione.
L’Admin registra una versione con motivazione e conferma. I nuovi account ricevono la versione esatta mostrata; se cambia nel frattempo, la creazione si interrompe senza account parziali.
Per un account esistente, l’Admin può applicare esplicitamente il profilo corrente dalla sua scheda. Il riepilogo identifica account ed email e chiarisce la sostituzione delle eccezioni individuali.
L’operazione non assegna progetti, clienti, documenti o incarichi, e non attribuisce accettazioni personali.
Il ruolo Admin e le capacità protette di esecuzione esterna restano esclusi da questo editor.

## Continuità e risultato certo

Tutti i nuovi editor conservano le scelte durante la riconferma privilegiata Admin.
Un identificativo stabile nell’URL lega la bozza al comando: la riconferma non prepara un comando diverso.
Dopo un’interruzione, usa Verifica esito registrato. Se non compare un effetto, la chiusura esplicita rende il tentativo terminale prima di aprirne un altro.
Un file eventualmente scritto prima di un rollback rimane privato; non è una versione acquisita né una concessione e non viene pubblicato per ripetizione cieca.

## Estensione SQL proposta

SQL esatto nel sorgente del candidato: `prisma/migrations/20261030190000_admin_residual_provenance_v1/migration.sql`, SHA256 `48782f5b5562a3bb5b9a90d3b5d9ee8982228bc23f8b44a82bf2c6a8b019bd28`. La copia di piano `docs/plans/admin-residual-provenance-schema74.sql` ha lo stesso hash. La presenza nel sorgente non attesta l'esecuzione su alcun database.
Richiede schema73 e il checksum qualificato della migrazione precedente; non riscrive righe esistenti.

- Estende il controllo SQL delle nuove versioni private esclusivamente per una ricevuta Admin della stessa transazione, legata alla fonte e alla versione precedente.
- Aggiunge la verifica reciproca ricevuta/versione, con audit e sessione Admin correnti; conserva i trigger di immutabilità esistenti.
- Fa avanzare l’epoca del servizio quando cambiano catalogo, contratto o pagamento, così un ripristino non riattiva vecchie decisioni o concessioni.
- Non aggiunge tabelle o colonne, non muta dati reali, non attiva provider o processi.

Prima di qualsiasi esecuzione produttiva: candidato esatto, CI richiesta verde, riesame indipendente pertinente, qualificazione SQL isolata, backup/ripristino fresco e piano deploy/rollback esatto.
Il rollback applicativo deve essere compatibile con le nuove versioni già presenti: il precedente lettore limitato a una versione non costituisce un rollback funzionale completo dopo l’uso di L03. L’eventuale ripristino DB rimane un’operazione qualificata separata.

La qualificazione R05 costruisce un’immagine di ritorno distinta: base PR245 più lettori compatibili, schema74 e dipendenze corrette, senza esporre i nuovi editor L01–L04. `scripts/admin-residuals/compose-compatibility.mjs` produce commit e tree deterministici senza cambiare HEAD, indice o branch. Manifesto, archivio sorgente e immagini sono conservati nell’artefatto CI. La prova attraversa candidato → avvio negato con sessioni precedenti → revoca sintetica esplicita → immagine compatibile → ripresa del candidato. Verifica i byte delle versioni1 e2, isolamento, rettifica corrente con formalizzazione originale conservata e permessi individuali dopo un nuovo login. Il ritorno conserva i dati e la consultazione; i nuovi editor restano sospesi fino alla ripresa del candidato. Questa è la procedura predisposta, non un PASS anticipato.

## Correzione della dipendenza di lint

La CI del primo candidato ha rilevato GHSA-g3hv-75wg-m249 in minimatch. Il lock usa soltanto la versione11.0.1 corretta; nessuna eccezione viene aggiunta a npm audit o OSV. L’adattatore `scripts/lint-minimatch-compat.mjs` espone ai plugin di lint il vecchio export CommonJS chiamabile usando il nuovo motore. Per l’unico consumatore di `makeRe`, eslint-plugin-import/no-internal-modules, espone il metodo `test` del matcher: non ricrea un generatore di espressioni regolari. È una compatibilità circoscritta agli strumenti installati, da riqualificare a ogni aggiornamento. Il test esercita realmente le regole React e import, oltre a confrontare i risultati con l’API ESM della versione corretta.

Fonte primaria: https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249.

Anche l’immagine compatibile legge i profili salvati quando prepara e registra un nuovo account: il ritorno non ripristina silenziosamente i permessi compilati precedenti. Restano assenti i nuovi editor di collegamenti, versioni private e profili globali. I file del consumo del profilo per gli account sono quelli esatti del candidato, già coperti dai test PostgreSQL e browser; R05 verifica il riepilogo della revisione nel runtime di ritorno.

## Prove predisposte e limiti dell’attestazione

Nuovi test: 4 unitari profili, 6 unitari integrità versioni, 7 unitari provenienza delle rettifiche; 12 PostgreSQL profili, 9 collegamenti, 8 formalizzazione, 12 versioni; 8 casi browser aggiuntivi complessivi rispetto a PR245 (3 profili e 5 collegamenti/versioni).
Questi numeri sono il piano dei casi. I risultati effettivi, gli hash e i gate stanno nel checkpoint e nel pacchetto del candidato; un caso predisposto non equivale a PASS.
I casi browser sintetici non attestano l’uso autenticato sul Chrome dell’utente. L’ultima osservazione di Stella resta /login, senza autenticazione.
