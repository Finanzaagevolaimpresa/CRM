# Checklist e scadenze nell’incarico tecnico

Preparazione locale successiva a PR216, sulla dipendenza esatta `81a7f8a960f71f20383098042de7728b1d8857df`. Nessun nuovo comportamento attivo, migration o concessione. La PR della coda Admin rimane congelata.

## Riutilizzo e lacune osservate

`DocumentChecklistItem` e `Task` sono già gestiti da azioni, pagine, ricerca, notifiche e report. Hanno collegamenti cliente/progetto/servizio ma non un riferimento alla pratica tecnica né una selezione personale dei singoli elementi. Il semplice collegamento al cliente non basta per ammettere un tecnico. `Deadline` è una proiezione generica senza versione: non è una base sufficiente per una nuova scrittura concorrente con ricevuta.

`technical-assignment-access.ts` verifica incarico, registro, autorità, contesto, revoca e scadenza. `technical-work-service.ts` dispone già di anteprima e ricevuta atomica, ma gestisce solo campi e stato del target. I nomi `manage_checklist` e `manage_deadlines` nel catalogo non sono operazioni attive.

Le pagine `technical-office/portals`, `integrations` e `reporting` contengono ancora «In preparazione». Non vengono considerate un flusso operativo.

## Incremento previsto

1. Riutilizzare i record checklist/attività con un collegamento esplicito, immutabile e verificato al preciso progetto o pratica. Non inferire appartenenza dal solo cliente o servizio. Preservare i record esistenti senza importarli automaticamente nel perimetro tecnico.
2. Nella decisione personale sugli incarichi selezionare i singoli elementi e i campi leggibili/modificabili. Elementi futuri e quelli di altri tecnici non sono ereditati. La selezione di un elemento non seleziona il suo documento: versione e download restano decisioni separate.
3. Nessuna modifica a referente commerciale, titolare, cliente, progetto, servizio, assegnatario o dati finanziari attraverso un comando checklist/attività. Letture ordinarie, ricerca, conteggi, notifiche, report e URL devono rispettare il nuovo vincolo anche dopo revoca.
4. Stato e ricevute richiedono transazioni serializzabili, versione attesa, confronto dopo anteprima, evento e audit atomici. Una risposta persa si riconcilia tramite ricevuta; niente retry della scrittura. «Richiesto» non può fingere un invio, «ricevuto/validato» non può fingere un documento disponibile: tali transizioni richiedono evidenze pertinenti.
5. Per una scadenza riutilizzare l’attività canonica. Una scadenza personale non crea destinatari, avvisi o email impliciti; eventuali regole «Chi aggiornare» restano nel loro distinto flusso autorizzato.

## Preparazione presente

`technical-work-item-contract.ts` prepara selezione e proiezione chiuse per singoli elementi, con diniego su target diverso, revoca, scadenza, cambio di contesto, metadati finanziari e campi non scelti. Non viene importato dal runtime; non amplia `technicalImplementedActions`. Le transizioni di stato e i collegamenti documentali non sono ancora scrivibili da questo contratto.

`technical-work-item-context.ts` prepara il legame al preciso target: una decisione personale conservata deve essere verificata prima di chiamarlo; collegamenti azienda/progetto/servizio già presenti impongono ulteriori limiti. Nessun riferimento viene riempito automaticamente. L’impronta cambia con revisione del legame e contesto corrente. Le due componenti superano 18 prove pure, lint mirato e typecheck; non sono ancora prova della persistenza o del percorso browser.

Prima di dichiarare l’incremento implementato servono persistenza e vincoli, chiusura delle vie ordinarie, UI di scelta/anteprima/lavoro, prove DB/browser con due tecnici e due commerciali, regressioni, migration concreta se necessaria e stesso riesame. Prima della produzione servono autorità precise sul nuovo piano. Nessun dato reale viene creato per collaudare le pagine.

## Anteprima e ricevuta del singolo elemento

`technical-work-item-command.ts` aggiunge il contratto preparatorio del comando: la firma distingue questa operazione dalle altre firme di incarico/email. L’anteprima dura al massimo cinque minuti ed è vincolata alla sessione, ai registri correnti, alla selezione personale, al legame elemento/target e alla versione dell’elemento. Qualsiasi cambio invalida la conferma precedente. Il digest distingue anche un UUID riutilizzato con contenuto differente; la ricevuta minimizzata permette la futura riconciliazione di una risposta persa senza mostrare i valori modificati.

Il comando ammette solo la modifica dei campi già selezionati. Stati, assegnatari, collegamenti ai documenti e notifiche non sono scritture rappresentabili da questo contratto. Il servizio futuro dovrà rileggere tutti i fatti sotto lock, verificare il giornale e persistere modifica/ricevuta/audit insieme. Non esiste ancora una route che lo esegua.

Il 24/10 la prosecuzione runtime è subordinata alla correzione separata delle dipendenze: PR216 è integrata nel merge `73e3043d68c19353931e8f628ad3140259b87caf`, ma la CI del merge ha bloccato il rilascio per gli avvisi postal-mime/Zod. SQL65 e produzione non sono stati modificati. Questa preparazione resta nel proprio branch; non altera il candidato PR216 congelato.

## Raccordo tra perimetro e proposta

`technical-work-item-plan.ts` collega i controlli già preparati: ricostruisce il contesto del singolo elemento, confronta identità/versione della riga, decisione personale, destinatario, incarico e scelta dei campi. L'anteprima mostra soltanto i valori effettivamente proposti; una scadenza viene normalizzata prima della firma. La conferma richiede la stessa proposta normalizzata e tutti i fatti correnti, e nega un elemento già modificato, una revoca, un altro tecnico, i commerciali, un contesto finanziario o una scelta cambiata. Non registra un esito di esecuzione: restituisce soltanto il piano che il futuro servizio dovrà persistere insieme a ricevuta e audit, dopo l'ultimo controllo temporale sotto lock.

Le quattro componenti preparatorie superano 38 prove pure, typecheck e lint mirato. Restano necessari migration candidata, transazioni reali, chiusura delle vie ordinarie e UI; non è stata attivata alcuna operazione o assegnazione.
