# Promemoria CRM su una scadenza esistente

Stato: preparazione su base PR233 `f1818bde23496b310a297b4f0ed3260bdce85e33`, schema70. Il nuovo candidato R12 aggiunge gestione Admin e browser nativo; la sua qualifica è ancora da eseguire. Nessuna migration o funzione produttiva dei promemoria è stata attivata.

## Flusso

Da cliente, progetto o pratica, l'Admin sceglie un'attività aperta con scadenza già presente, data e ora del promemoria, persone o gruppi esistenti. La pagina filtra prima della paginazione secondo contesto e autorità correnti. Attività finanziarie, di altri contesti e attività private non ammesse restano escluse. Le attività private richiedono l'autorità tecnica personale già esistente.

Il modulo mostra il fuso del dispositivo; il riepilogo aggiunge ora di Roma e istante UTC esatto. L'anteprima elenca persone incluse ed escluse per accesso assente o in scadenza. Conferma personale e consenso esplicito sono necessari; scegliere un destinatario non gli concede accesso. Riepilogo e avviso non includono titolo della Task, descrizione, note, documenti o dati finanziari.

La conferma registra comando, evento e destinatari nella coda RecordUpdate esistente, audit minimo e journal firmato, in una sola transazione. Conserva data di registrazione e istante futuro distinti. Il journal lega versione della sorgente, directory, destinatari, autorizzazioni, sessione, chiave e comando. I vincoli differiti sono verificati prima del ritorno dal servizio. Non vengono ritentate mutazioni incerte.

## Disponibilità, lettura e annullamento

Liste, conteggi e dettagli usano le Notifiche già presenti. Il promemoria diventa disponibile all'istante scelto solo se sorgente, persone, gruppi, permessi, incarichi, documenti, scadenze e sessione sono ancora ammessi. La scansione filtra prima del limite; le route dirette applicano gli stessi controlli. Le GET non scrivono né inventano consegne o letture. Il comando «Segna come letto» conserva il primo istante effettivo.

L'Admin autore consulta i propri promemoria e distingue Programmato, Disponibile, Letto, Sospeso e Annullato. Se la sorgente non è più ammessa, titoli, dati delle persone e collegamenti non vengono restituiti. Le letture già avvenute rimangono fatti storici.

L'annullamento personale è terminale: aggiunge registro immutabile e audit senza eliminare lo storico. Blocca anche la riapertura dei destinatari che avevano letto. Rimane disponibile all'autore dopo il cestino della sorgente. Non ripristina attività o concessioni.

Prima della mutazione il browser conserva l'identificativo del comando nell'URL. Dopo una risposta persa o una riapertura offre solo la verifica dell'esito, senza ripetere il salvataggio. Vale anche per l'annullamento. Una modifica di gruppo, Task o permessi invalida la proposta; ripristinare valori precedenti non riattiva una decisione obsoleta.

## Evidenze e limiti correnti

- R10, commit `9d5821be39b29bf2baacf9cda118b5861616a9e2`, run `40726929245`: 41 prove pure e 49 PostgreSQL passate, limitate a quell'HEAD.
- R11, commit `b876e723412c615acae07adfc2fe6dda4f4f9e17`, run `40732569787`: 41 pure e 53/55 PostgreSQL passate. Due fixture non valide sono corrette nel nuovo candidato: istante oltre la scadenza del permesso e motivo di revoca sessione estraneo all'enum. Nessun controllo applicativo è indebolito.
- R12 prepara 61 scenari DB e 6 browser nativi: due commerciali e due tecnici, accessi positivi e dinieghi, orologio reale, gruppi, gestione Admin, revoca, ricevuta, annullamento, risposta persa, replay, origine della richiesta e viste desktop/mobile. Questi risultati non sono ancora qualificati.
- `tests/record-reminders/synthetic-extension.sql` è protetto dal nome e sentinel del database effimero, fuori da Prisma/migrations. Non è un piano produttivo e non riserva un numero di schema.
- Si riusano coda e orologio delle letture: nessun nuovo scheduler o worker. AVAILABLE e READ non attestano push o email. L'email richiede la separata bozza e approvazione della versione esatta.
- Nessun task reale, promemoria corso, avviso o invio è stato creato. Il cron INBOX rimane distinto.

## Lavoro residuo

Qualificare l'HEAD corrente e ispezionare le schermate native; preparare migration additiva, compatibilità, recuperabilità, regressione completa e immagine; consegnare diff e piano all'unico revisore. SQL, merge e rilascio richiedono l'autorità pertinente sul candidato e target concreti. Non distribuire codice che interroga le nuove strutture prima della loro migration qualificata.
