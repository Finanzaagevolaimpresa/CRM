# Deposito documentale dall'incarico tecnico — preparazione

Base di preparazione: PR218, `917c911107228227117f331411e4c9d88ecfa411`. La PR218 è in riesame; questa preparazione non ne modifica i file congelati e non attesta integrazione o distribuzione.

## Lacuna verificata e riuso

`technical-assignment-contract.ts` prevede `upload_document`, ma lo esclude da `technicalImplementedActions`; management, admission e service negano la sua concessione. Il tecnico ammesso al solo progetto/pratica non deve ottenere il fascicolo cliente per caricare un elaborato.

`document-upload.ts` richiede il normale accesso di scrittura al contesto cliente e crea subito `Document`, versione e audit. Non è un servizio da chiamare con un attore privilegiato per superare il perimetro tecnico. `storage.ts` offre già salvataggio privato, chiave stabile, scrittura esclusiva e confronto dei byte su replay. `technical-assignment-access.ts` legge soltanto versioni selezionate, con verifica corrente di firma, sessione, contesto, checksum e download separato. Nessuna nuova versione è inclusa automaticamente.

## Prima capacità prevista

L'Admin personale potrà abilitare nel singolo incarico un profilo esplicito di deposito: finalità, formati, dimensione per file e quote per revisione. I vecchi incarichi non ereditano la capacità. La gestione di upload sarà distinta dalle concessioni di lettura e download.

Un deposito tecnico resterà privato, in un registro dedicato di proposte, fuori da `Document`/`DocumentVersion` e dai normali indici del fascicolo, finché l'Admin non deciderà la sua acquisizione e visibilità. Nessuna relazione ordinaria, altro tecnico o regola di notifica dovrà rendere il deposito leggibile. La futura acquisizione nel contesto canonico richiederà una decisione personale distinta: il deposito non sarà pubblicazione, allegato email, concessione, avanzamento checklist o invio.

Il limite massimo riusa quello approvato: 25 MiB per file, fino a 20 file per revisione e un massimo totale esplicitamente inferiore o uguale alla somma. File ZIP e metadati finanziari sono esclusi; gli altri formati già ammessi restano possibili solo se selezionati. La verifica delle estensioni o delle etichette non attesta il contenuto semantico: il deposito privato e la revisione Admin restano necessari. Formati opachi non vengono estratti o eseguiti. L'anteprima inline riusa i soli formati passivi verificati; gli altri sono allegati privati.

## Contratto puro implementato qui

`technical-upload-contract.ts` descrive i byte esatti, valida il profilo, lega l'anteprima a persona/sessione, decisione e revisione, autorità, generazioni, contesto, quota corrente, nome/titolo/hash/dimensione e scadenza. La validità è al massimo cinque minuti. Un cambio di quota o perimetro rende obsoleta l'anteprima. Il dominio HMAC è distinto da assegnazioni, modifiche ed email.

La ricevuta storica contiene solo identificativi, impronte e dimensione: `PRIVATE_STORED` non è `PUBLISHED`. La riconciliazione di risposta persa non restituisce titolo, percorso o token di lettura. Nessun ramo runtime importa questo nuovo modulo; `technicalImplementedActions`, parser storico degli incarichi, UI, DB e storage restano invariati.

## Persistenza e integrazione ancora da implementare

1. Estensione opzionale del payload firmato, senza cambiare la serializzazione delle decisioni storiche; gestione Admin con anteprima personale.
2. Registro proposte/ricevute e quota, con immutabilità, FK restrittive e audit atomico. Prima di scrivere una migration: schema e SQL esatti, compatibilità, riesame e autorità produttiva pertinente.
3. File privato con namespace separato, UUID del comando, hash e scrittura `wx`; nessun override di storage/credenziali. Il filesystem non è transazionale con PostgreSQL: un file orfano dopo rollback non diventa leggibile né viene ritentato con byte diversi. Nessun nuovo cleanup/cron o cancellazione automatica è incluso.
4. Lock corrente di sessione, autorità, target, decisione e quota; quota e ricevuta commit insieme. Revoca/archivio a finestra aperta impediscono nuovi depositi e letture. Il servizio ricostruisce il descrittore dai byte alla conferma; il browser non può dichiarare checksum o dimensione autorevoli.
5. Lettura autenticata dei soli depositi correnti dell'autore e dell'Admin competente, distinta dall'esito storico. Rilettura dei permessi prima di esporre metadati/byte; nessun GET che scrive. Admin decide acquisizione, classificazione e versioni da condividere mediante flussi personali esistenti o una loro estensione esatta.
6. UI desktop/mobile, recupero dell'esito incerto, test DB concorrenti e browser con contenuti sintetici reali. Due tecnici e due commerciali: positivo dell'autore ammesso, dinieghi reciproci, URL/API/ricerca/contatori/report/anteprime/download e nessuna visibilità da relazioni ordinarie.

Il contratto puro non sostituisce questi controlli. Non esiste ancora un incremento distribuibile, una PR dedicata, una qualifica DB/browser o un'autorizzazione produttiva. Nessun provider, worker, binding, concessione o dato reale è stato attivato.
