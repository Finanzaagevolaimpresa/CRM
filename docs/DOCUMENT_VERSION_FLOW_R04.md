# Versioni documentali nel percorso ordinario

Il collegamento Versioni apre lo storico del documento già ammesso al lettore.
L'operatore che possiede sia i permessi correnti di lettura/scaricamento sia quelli
di caricamento e modifica del contesto può aggiungere nuovo contenuto. L'azione
mantiene nome, formato, classificazione e collegamenti canonici; non sovrascrive
il file precedente. Si usa DocumentVersion esistente: nessuna nuova migration.

Un diverso formato o nome canonico richiede un documento distinto. I documenti
vincolati a contratto firmato, pagamento, formalizzazione o acquisizione tecnica
rimangono nei rispettivi percorsi verificati. Il deposito tecnico resta separato
da caricamento ordinario, revisione personale e acquisizione.

Il servizio rilegge e blocca sessione, utente, contesto di progetto e documento.
Rivaluta ruolo, permessi, lifecycle, collegamenti finanziari e scadenza prima del
salvataggio e l'istante della sessione prima del commit. Confronta la revisione
vista dall'operatore, aggiunge una sola versione e aggiorna documento e ricevuta
audit nella stessa transazione serializzabile. La ricevuta conserva soltanto
identificativi e hash ammessi dal filtro privacy, mai contenuti o nomi file.

La richiesta ha un'identità personale persistita nella sessione del browser
prima dell'invio. Doppio clic e risposta persa non producono un nuovo comando.
Dopo risposta incerta o ricaricamento è disponibile soltanto Verifica esito
caricamento. Assenza della ricevuta o revoca dell'accesso non diventano prova di
mancato salvataggio. Il file privato usa un percorso immutabile per comando;
un eventuale file orfano dopo rollback resta privato, senza pulizie automatiche.

Le vecchie versioni restano consultabili attraverso il controllo ordinario
corrente. Lo storico usa pagine di 50 elementi. Un incarico selettivo non apre
questa pagina né eredita le nuove versioni: i trigger esistenti invalidano la
vecchia fotografia della concessione; l'Admin deve verificare e scegliere di
nuovo versione e permesso di download. Contratti e pagamenti restano riservati.

Lo storico mostra l'ora di registrazione in Europe/Rome esplicito. L'elemento
time conserva l'istante ISO originale: nessuno spostamento del dato persistito.
Il browser verifica anche un istante nell'ora ripetuta di ottobre, con dispositivo
Asia/Tokyo, prima e dopo un caricamento e la riapertura dello storico. Il centro
documentale mostra in Roma anche scadenza e tracciabilità; la prova confronta
la scadenza esposta con l'istante persistito rimasto identico dopo la nuova versione.

## Qualifica richiesta

Dieci prove PostgreSQL isolate verificano byte precedenti, idempotenza, due
comandi concorrenti, ricevuta personale, revoca, clienti diversi, vincoli
finanziari, formato/revisione obsoleti, concessione esatta e paginazione.
Due prove browser native coprono Admin e Commerciale, risposta persa e recupero
dopo reload, apertura effettiva dei byte precedenti da tecnico ammesso, diniego
all'altro tecnico e revoca con pagine aperte. Gli screenshot desktop/mobile
devono essere ispezionati sull'HEAD qualificato. Nessun dato reale è una fixture.

Lo stato iniziale di questo documento descrive il candidato implementato;
non attesta esecuzione delle prove CI, riesame, integrazione o distribuzione.
Il rilascio resta subordinato al piano esatto, al PASS indipendente, alla CI,
all'immagine del merge, al backup con ripristino provato e al preflight fresco.
