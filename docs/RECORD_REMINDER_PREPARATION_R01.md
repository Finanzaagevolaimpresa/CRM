# Promemoria operativi: contratto e anteprima autorizzata

Stato: contratto puro e servizio di anteprima in sola lettura, ancora senza collegamenti alle pagine o salvataggio dei promemoria. Il promemoria non è ancora una funzione disponibile. Base riconciliata con PR232, commit `64456df39837e5931900b7196b09e857568b751a`, schema69. La lavorazione non modifica il candidato PR233 e non applica SQL70.

Il primo incremento programma un solo avviso CRM per un'attività con scadenza già presente, nel contesto cliente, progetto o pratica verificato. L'Admin sceglie istante e persone o gruppi esistenti. L'anteprima distingue destinatari ammessi, accesso assente e accesso che scade prima del promemoria. Nessuna concessione nasce dalla selezione. Una data scaduta può essere oggetto di un nuovo promemoria futuro esplicito; non viene rappresentata come una nuova scadenza.

## Preparazione implementata

Il servizio `previewRecordReminder` autentica la sessione reale dell'Admin e la sua conferma personale. Nella stessa transazione serializzabile legge chiave registrata, elenco corrente delle persone, autorità tecnica distinta, utenti, contesto canonico, Task e generazioni. L'anteprima firma il riepilogo per la sessione e il comando esatti, per non più di cinque minuti e comunque entro la finestra corrente. Le sole letture non producono Task, avvisi, ricevute, audit o concessioni.

Per i tecnici viene verificato il registro firmato dell'incarico, inclusi autorità, revoca, scadenza, epoche, perimetro, documenti e scelta esplicita del campo `dueAt` della singola Task. Non si inventa una sessione del destinatario e non si ricava accesso dalla sola responsabilità storica. Per i destinatari ordinari si applicano i controlli correnti del record e della Task. Le attività private restano sotto l'autorità personale tecnica anche per l'Admin. Il riepilogo non include titoli, descrizioni, note, importi, file o informazioni finanziarie.

Le 37 prove pure coprono anche separazione fra tecnici, revoche, ripristino delle autorità, scadenza dei token e alterazioni del riepilogo. Sono preparate 14 prove PostgreSQL con due commerciali e due tecnici e workflow dedicato su database effimero. Il loro esito deve essere acquisito dalla CI sull'HEAD esatto; la presenza del file di test non costituisce qualifica database.

Si riusano RecordUpdateCommand, RecordUpdateEvent, RecordUpdateDelivery e i selettori esistenti. Il nuovo contratto lega comando, sessione, epoca dell'Admin, contesto, attività, generazione, scadenza, istante del promemoria e ammissioni individuali. Il riepilogo ammette soltanto DEADLINE/dueDate, senza descrizioni private, titoli non autorizzati, allegati, importi o indirizzi. La generazione della Task è già conservata da TechnicalWorkItemGeneration, anche attraverso modifica e reinserimento: non occorre inventare un altro contatore di versione.

## Integrazione ancora necessaria

- Qualificare in PostgreSQL il servizio di anteprima e i suoi lock insieme alle revoche e alle modifiche del contesto. La sola lettura del cliente non basta per una Task privata.
- Conferma e riconciliazione del medesimo comando: in una sola transazione salvare evento, lavoro selezionato, vincoli immutabili del promemoria e audit minimo. Riutilizzare la deduplica evento/destinatario. I test dell'anteprima non provano ancora l'atomicità del futuro salvataggio.
- Estensione SQL additiva del meccanismo RecordUpdate, con data di disponibilità e sorgente versionata. Definire un annullamento esplicito e tracciato. Non riutilizzare scope, occurredAt o la scadenza della regola come data di invio; non creare una seconda coda. Non è ancora stata creata una migration né riservato un numero di schema.
- Letture e conteggi: interrogare l'orologio DB e ripetere i controlli correnti. Prima dell'istante, lo stato programmato è visibile soltanto all'Admin autorizzato nella gestione; le liste dei destinatari escludono SCHEDULED. Dopo l'istante usare AVAILABLE, poi READ soltanto in presenza di una ricevuta reale. GET non scrive e la disponibilità non prova consegna push o email.
- Una modifica della Task, del perimetro, del referente, del gruppo o delle epoche invalida il lavoro precedente; ripristinare valori vecchi non riattiva la vecchia decisione. Conservare storico e motivo minimizzato per l'Admin, senza divulgare contenuti a chi non ha più accesso.
- UI desktop/mobile con fuso esplicito, riepilogo e gestione di doppio clic, risposta persa, riapertura e annullamento. Una nuova decisione richiede il contesto corrente; un esito incerto resta da riconciliare.
- L'eventuale email segue una funzione successiva sul percorso di bozza esistente e richiede sempre la decisione personale sulla versione esatta. Nessun invio o runner è dedotto dalla programmazione CRM; nessuna modifica al cron di ricezione.

## Qualifica richiesta prima del rilascio

Prove PostgreSQL e browser native su dati sintetici: due commerciali e due tecnici, contesti distinti, Task private autorizzate, prima/all'istante/dopo, cambio ora e fuso, modifica/annullamento/revoca/scadenza, concorrenza, rollback, doppio clic, risposta persa, conteggi, ricerca, URL diretti, ricevute di lettura e limiti email. La funzione sarà completa solo dopo adapter, SQL e UI, prove sulla versione esatta e riesame pertinente. Piano concreto, autorità SQL e rilascio restano separati. Nessun task reale o avviso corso è stato creato.
