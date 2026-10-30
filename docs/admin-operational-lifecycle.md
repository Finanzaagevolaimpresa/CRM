# Stati amministrativi delle fonti operative

La fase aggiunge a cinque tipi di fonte — acquisizione controllata, pratica preventivo/avvio, comunicazione, risposta ricevuta e documento acquisito privatamente — una gestione Admin di blocco, archivio, cestino e ripristino. Non rappresenta la chiusura dell'intero incarico Admin master.

## Percorso operativo

Aprire **Admin → Dati e correzioni amministrative → Stato delle schede operative**, oppure **Blocco, archivio e ripristino** nel contesto della scheda. Selezionare area, stato e riferimento; aprire la fonte. Scegliere il nuovo stato, motivare e confermare il riepilogo.

- **Operativo:** ammette il lavoro secondo i permessi e i vincoli originali.
- **Bloccato:** sospende le operazioni, conservando la consultazione autorizzata.
- **Archiviato / Nel cestino:** conserva fonte e prove; la fonte non è disponibile nelle viste operative delle altre persone.
- **Ripristina operatività:** riapre il lavoro. Non ripete avvii personali, autorizzazioni, invii o decisioni storiche.

Il blocco di un'acquisizione si propaga alla sua pratica preventivo/avvio; quello della pratica si applica alle attività, ai dossier e alle comunicazioni collegate. Scollegare un elemento dal servizio precedente non aggira il blocco. I documenti già consultabili conservano i loro permessi specifici.

La conferma Admin dura trenta minuti. Se scade durante la scelta, la conferma in pagina conserva stato e motivazione; l'operatore ripete consapevolmente il salvataggio dopo aver confermato la propria identità. Una risposta interrotta conserva nell'indirizzo il riferimento del comando. **Verifica esito registrato** legge la ricevuta; non ripete la mutazione. Quando non esiste un esito, **Riconcilia e chiudi il tentativo** impedisce anche l'arrivo tardivo del vecchio comando. Solo dopo la chiusura si apre una nuova operazione.

Le comunicazioni con invio aperto o esito incerto non possono essere sospese finché l'esito non è riconciliato. Una storia ampia di messaggi conclusi o bozze non impedisce la gestione. Dopo il ripristino di una comunicazione o del suo contesto occorre salvare una nuova versione prima di una nuova approvazione o preparazione all'invio. Le anteprime e le decisioni conservano le proprie scadenze.

Il documento tecnico acquisito privatamente resta vincolato all'autorità personale e alle prove originali. Ogni cambio di stato invalida le vecchie selezioni del documento. Il ripristino riapre la consultazione Admin ammessa, ma non riattiva le versioni concesse in precedenza. Non altera firme, hash, acquisizione, versioni o byte.

## Schema e vincoli

La migrazione additiva 73 crea solo la tabella **AdminOperationalState** con riferimenti alle fonti, registrazione iniziale ACTIVE/versione zero e protezioni SQL dei percorsi nativi. Le fonti preesistenti sono iscritte nella nuova tabella senza riscriverne le righe e senza inventare decisioni Admin. Il prefisso di 72 migrazioni resta invariato.

Ogni transizione richiede utente/sessione/permessi/prova Admin correnti, hash della fonte e dello stato attesi, comando univoco, motivazione, journal e audit nella stessa transazione. Il journal e le fonti storiche restano immutabili. La riga di stato persistente e i lock condivisi impediscono a un comando partito su una fotografia precedente di proseguire dopo il blocco.

Il cambio di stato di un documento privato incrementa l'epoca selettiva del documento nella stessa transazione: è un'invalidazione tracciata della selezione, non una riscrittura della prova di acquisizione.

## Qualificazione e rilascio

La CI verifica separatamente la migrazione storica 71→72 e la nuova 72→73; controlla prefisso, conservazione delle righe, base errata, rollback atomico con guasto, divieto di riapplicazione e assenza di nuovo drift del modello. Le prove PostgreSQL comprendono concorrenza, snapshot precedente al primo blocco, esiti persi, chiusura contro un writer in corso, prove originali, isolamento e invalidazione delle selezioni. I test browser verificano riconferma, riapertura e recupero senza duplicati.

Il riavvio sintetico del medesimo candidato conserva anche blocchi, ripristini e ricevute dei comandi chiusi. È distinto dal ripristino di un backup e da un rollback applicativo.

Prima della produzione occorrono candidato e SQL esatti, CI richiesta verde, riesame indipendente specifico, backup/ripristino fresco e piano di esecuzione qualificato. Il vecchio binario schema72 non è un fallback valido quando sono in uso gli stati schema73: non applica tutti i nuovi filtri di lettura. Non sono inclusi down migration, ricostruzione del database o ripristino automatico del database produttivo. Il pacchetto esecutivo deve qualificare un recupero applicativo compatibile con schema73.

## Limiti ancora separati

I percorsi aggiunti successivamente sono descritti in [metadati privati](admin-private-document-metadata.md) e [contesto delle bozze](admin-draft-context.md). Restano espliciti il writer Admin di nuove versioni binarie della stessa fonte privata e la riconciliazione autoritativa di un invio SMTP incerto. La [guida complessiva](admin-master-operativita.md) distingue le funzioni disponibili dalle limitazioni residue. I collaudi sintetici non attestano il collaudo dell’interfaccia in produzione.
