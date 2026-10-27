# Contatto antecedente all’ingresso nel CRM — preparazione

Questo ramo dipende dal candidato PR232. Contiene contratto, persistenza, conversione e anteprima candidati, oltre a un componente non ancora montato in una pagina. Non introduce route, action, migration della catena Prisma, attivazioni o invii. La catena produttiva resta a schema69.

Stato corrente del 27/10: registrazione e conversione sono qualificate con 34/34 prove PostgreSQL sul commit `b78e465f997a447f6f3b4b94a34d393753367de2`, run `40564986437`, job `122403764954`. Il successivo delta di anteprima aggiunge sei scenari database, da qualificare sul proprio nuovo commit: non eredita quel PASS. Le sezioni preparatorie più sotto sono conservate come cronologia.

Il nuovo riepilogo firmato scade entro cinque minuti o prima, se scade la sessione. Vincola evento, fonte, riferimento, comando, attore, sessione, inbox, ciclo, versione e accettazione del referente; il salvataggio ricontrolla il registro della chiave esistente, i permessi e la scadenza nella stessa transazione. Nessuna nuova credenziale o autorità Admin è creata. Il componente distingue data effettiva e data del salvataggio, richiede il fuso dell’evento e conserva nell’URL il solo comando prima dell’invio: dopo risposta persa rimane disponibile soltanto la verifica dell’esito. La fonte resta una dichiarazione, non una prova automaticamente verificata. Il componente e le nuove sei prove devono ancora superare la qualifica nativa: non sono un flusso produttivo completato.

Aggiornamento del 27/10: la sola registrazione e riconciliazione del contatto è qualificata con 14/14 prove PostgreSQL sul commit `36498187c62452f778874ab333f3ebfce3a43b92`, run `40562224791`. Le sezioni successive descrivono anche le fasi preparatorie conservate. La nuova conversione descritta in fondo richiede una qualifica sul proprio commit; non eredita quel PASS.

Il percorso corrente non può rappresentare correttamente un contatto anteriore alla creazione del lead: `CommercialLeadSlaCycle` richiede `firstResponseAt >= availableAt` e l’azione esistente registra l’ora del comando nel database. La conversione controlla una risposta corrente. Non modificare queste date o registrare un contatto fittizio.

La registrazione storica proposta mantiene distinti l’evento reale (`occurredAt`), la fonte e il riferimento della prova, il referente che attesta e la data di registrazione determinata dal database. L’Admin assegna; il commerciale corrente accetta la decisione di responsabilità e attesta il contatto effettivo. Un cambio A→B→A richiede la nuova accettazione. La fonte è un riferimento dichiarato dall’operatore, non una prova verificata automaticamente e non un URL da aprire automaticamente.

Il servizio candidato rilegge e blocca sessione, lead, inbox e ciclo e verifica la decisione di responsabilità e la sua accettazione sotto lo stesso lock del lead. Il contratto puro non sostituisce questi controlli. La prima versione riguarda il primo ciclo di un lead manuale, aperto, non convertito, non nel cestino e senza una risposta già registrata.

La persistenza richiede una ricevuta immutabile separata, con comando univoco e hash del contenuto. Scrittura, avanzamento della versione inbox e audit minimo dovranno essere atomici. La risposta persa si riconcilia attraverso lo stesso comando; l’assenza di ricevuta non autorizza una ripetizione. Le prove dovranno coprire cambi di referente, revoche, concorrenza, doppio comando e rollback dell’audit.

Il contratto puro prepara la conversione soltanto da una ricevuta persistita e ancora pertinente: ricontrolla referente, sessione, accettazione corrente, ciclo, hash e versione. Produce la base distinta `HISTORICAL_CONTACT_BEFORE_CRM`, lasciando `firstResponseAt` nullo. Questa funzione non è collegata alla conversione esistente. Il corrispondente esito SLA richiede una nuova SQL esplicita e prove database prima dell’integrazione: non sarà `MET` o `BREACHED` per un’attività mai avvenuta nel ciclo CRM. Le date e gli esiti esistenti rimangono immutati. Nessuna scorciatoia tramite note o audit generico.

Restano da implementare modello/SQL, servizio transazionale, acquisizione e lettura della ricevuta, integrazione con conversione e indicatori, modulo con anteprima e data esplicita, prove PostgreSQL/browser e piano preciso di compatibilità. Una nuova SQL o un rilascio richiederanno riesame e autorità sul candidato/target esatti. Nessun dato del caso reale è usato come fixture.


## Persistenza candidata, ancora non collegata

Il modulo `commercial-lead-historical-contact-storage.ts` prepara una transazione serializzabile che blocca sessione, lead, inbox e ciclo e rilegge decisione e accettazione correnti. Registra ricevuta immutabile, versione inbox e audit minimo nello stesso commit; legge l'esito solo dopo una nuova autorizzazione corrente. Una ricevuta assente resta `NOT_OBSERVED`, senza autorizzare una ripetizione.

`ops/n14-historical-contact-schema.draft.sql` è esclusivamente una DDL per il database isolato con sentinel: rifiuta l'esecuzione su un database diverso. È fuori dalla catena Prisma, che resta schema69. Nessuna tabella o riga produttiva viene creata. I trigger vietano modifica/cancellazione/truncate e vincolano la ricevuta alla stessa transazione dell'audit e dell'avanzamento di versione.

La ricevuta è unica per inbox e decisione di responsabilità. Un cambio di assegnazione conserva il precedente evento e richiede una nuova accettazione ed attestazione pertinente; nessuna approvazione passa al nuovo referente. La persistenza non modifica il ciclo SLA: integrazione, esito storico esplicito, filtri e conversione devono essere completati e qualificati insieme prima di collegare un'azione o una pagina. Il modulo non è ancora qualificato su PostgreSQL; nessuna prova locale pura viene attribuita alla persistenza reale.

## Prove PostgreSQL predisposte

`tests/db/commercial-lead-historical-contact-db.test.ts` prepara quattordici scenari: date e SLA preservati, riconciliazione dopo risposta persa, replay esatto, comandi concorrenti anche con contenuti diversi, rollback dell'audit, titolarità e accettazione personali, revoca di permessi/sessione e sospensione, riassegnazione A→B→A, risposta corrente già registrata, immutabilità e vincolo differito della transazione. Sono richiesti CI, database loopback `fai_crm_test` e sentinel verificato; le prove usano uno schema isolato e la DDL candidata, senza dati reali.

La lettura locale del file di test mantiene disabilitata l'esecuzione PostgreSQL. La sua compilazione non è un PASS database: resta necessario pubblicare e verificare un job CI dedicato prima di integrare il servizio nel percorso operativo.

Il workflow `n14-historical-contact.yml` prepara questa qualifica sul solo branch dedicato o sul diff pertinente della PR. Richiede quattordici prove eseguite e superate, nessuno skip; conserva HEAD, tree e log TAP. Usa un servizio PostgreSQL effimero, senza secrets o accessi produttivi. La sola presenza del workflow non attesta ancora l'esecuzione o il PASS. La catena Prisma resta a schema69 e il modulo rimane privo di route/action.

Il primo job PostgreSQL ha rilevato che il filtro privacy esistente eliminava alcune chiavi del nuovo audit. Il formato candidato usa ora soltanto `type`, `recordId`, `beforeVersion`, `afterVersion` e `outcome`, ammessi dal filtro; il filtro stesso rimane invariato. La prova positiva confronta l'audit effettivamente persistito e verifica che non contenga il riferimento della fonte. Le prove con guasto artificiale richiedono l'errore specifico atteso, oltre al rollback completo: un rifiuto precedente non vale come prova del guasto. La correzione deve superare un nuovo job sul proprio commit.

Un conflitto di serializzazione provoca soltanto una nuova lettura autorizzata dello stesso comando: se la ricevuta persistita coincide con il contenuto richiesto viene restituita, altrimenti l'operazione resta rifiutata. Non si ripete automaticamente la scrittura. Il vincolo differito del registro viene inoltre verificato esplicitamente prima di uscire dalla transazione, affinché un errore PostgreSQL emerga al chiamante senza una falsa ricevuta di successo.

## Conversione candidata nello stesso workflow N14

La funzione esistente `convertCommercialLeadInboxItem` accetta un riferimento storico soltanto dal servizio candidato, dopo lettura della ricevuta, sessione, permessi correnti, referente e accettazione personale. Nessuna action o pagina passa ancora quel riferimento. Il percorso ordinario continua a richiedere la prima risposta effettiva: la sola presenza del contatto storico non cambia quel gate.

`ops/n14-historical-conversion-schema.draft.sql` resta limitata al database sintetico con sentinel e fuori dalle migration Prisma. Estende il vincolo SLA con l'esito chiuso `HISTORICAL_CONTACT_BEFORE_CRM`, senza modificare `availableAt`, `dueAt`, la policy o `firstResponseAt`. Un trigger differito impedisce quell'esito senza la ricevuta di conversione della stessa transazione. I contatti storici non vengono classificati come SLA rispettati o violati.

La conversione usa le stesse righe Lead/Inbox/Ciclo/Client e lo stesso storico di chiusura N14. La ricevuta immutabile collega comando, contenuto, attore, sessione, contatto e cliente creato; non è una seconda coda. La risposta persa viene riconciliata con una lettura autorizzata del comando. Un comando diverso, un contenuto cambiato, un referente revocato o un cliente nel cestino non permettono di ripetere la scrittura o divulgare l'esito. I normali tentativi serializzabili del workflow rileggono prima il comando e non creano un secondo cliente.

Sono predisposte 34 prove PostgreSQL complessive: registrazione, conversione e riapertura dell'esito, gate ordinario, concorrenza fra conversioni e risposta corrente, revoche, A→B→A, riferimenti estranei, atomicità in sei punti del workflow e vincoli differiti. Nessuna conversione o contatto reale è eseguito. Restano UI con anteprima, indicatori/report SLA, modello/migration effettivi, prove browser e piano di rilascio con autorità specifica.
