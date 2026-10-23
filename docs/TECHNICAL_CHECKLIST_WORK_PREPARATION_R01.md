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

Prima di dichiarare l’incremento implementato servono persistenza e vincoli, chiusura delle vie ordinarie, UI di scelta/anteprima/lavoro, prove DB/browser con due tecnici e due commerciali, regressioni, migration concreta se necessaria e stesso riesame. Prima della produzione servono autorità precise sul nuovo piano. Nessun dato reale viene creato per collaudare le pagine.
