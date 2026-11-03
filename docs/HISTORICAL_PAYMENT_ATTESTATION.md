# Rettifica storica dell'incasso su attestazione Admin

In **Pagamenti**, nella riga della rata esistente, l'Admin sceglie **Rettifica storica · attestazione Admin**. Lo stesso collegamento è disponibile nell'editor Admin e nella conferma documentale. Questa fonte alternativa registra un'attestazione espressa del titolare; non è una verifica bancaria e non richiede un contratto firmato o allegati.

Il modulo richiede giorno effettivo dell'incasso, giorno dell'attestazione, titolare dichiarante, provenienza e motivazione. L'importo proviene dalla rata e non è modificabile. Il riepilogo mostra valori precedenti e risultato; dopo la conferma privilegiata personale, **Registra incasso storico** aggiorna solo la rata esistente. Non firma contratti, crea servizi, muove denaro o invia comunicazioni.

La fonte conserva precisione **DAY**, ora e metodo non dichiarati. Il precedente valore amministrativo del metodo resta nello storico. `Payment.collectedAt` usa mezzanotte UTC come normalizzazione tecnica: non è l'ora dell'accredito. Registro e fascicolo Admin leggono il giorno dalla fonte tipizzata e lo mostrano senza ora. Data/ora della registrazione CRM sono indicate separatamente.

La transazione serializzabile blocca cliente, contratto e rata e verifica nuovamente sessione, ruolo Admin, permessi, stato, collegamenti, importo e riepilogo. Solo rate da incassare/scadute senza incasso o prova precedente e senza servizio collegato sono ammesse. Il riepilogo dura tre minuti; la conferma Admin non ne estende la durata.

Il modello logico `PaymentHistoricalAttestation` riusa `AdminRecordRevision`: valori prima/dopo, fonte, autore/sessione, motivazione e hash sono immutabili. Il relativo `AuditLog` resta minimizzato dal filtro N04 e legato atomicamente alla revisione. Non serve una migrazione. La fonte può essere riaperta dal registro e dal fascicolo.

Se la risposta manca, **Verifica esito** usa lo stesso commandId sotto i medesimi lock; non invia una seconda registrazione. L'assenza del browser storage impedisce l'invio. Una conferma privilegiata scaduta conserva la bozza. Un esito già persistito non può essere sovrascritto o duplicato da un'altra attestazione.

La conferma documentale ordinaria conserva i propri requisiti. L'assenza di contratto o contabile non viene trasformata in una prova verificata. Ufficio tecnico, Consulente e ogni altro profilo con funzione tecnica non ricevono nuove autorizzazioni: pagina e azioni sono negate sul server; importi, note, fonte e audit restano fuori dalle proiezioni tecniche. La nuova rettifica è riservata all'Admin.

Le eventuali esecuzioni reali richiedono un mandato che identifichi rate e fatti; nessun identificativo o dato cliente reale è incluso nel codice o nelle fixture. Le divergenze sulle firme rimangono separate dall'attestazione di incasso.
