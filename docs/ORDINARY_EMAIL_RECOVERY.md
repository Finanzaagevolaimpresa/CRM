# Recupero Admin di un esito email ordinario

La schermata Comunicazioni mostra la ricevuta di ciascun tentativo. Per un tentativo prenotato, preso in carico o incerto, l’Admin può scegliere **Verifica prova ed esito dello stesso tentativo**. La consultazione non invia messaggi e non registra un esito.

Quando esiste una prova valida, il riepilogo presenta l’esito osservato, l’istante, l’impronta della prova e la scadenza dell’anteprima. L’Admin indica il motivo e conferma la riconciliazione. La conferma privilegiata deve essere ancora valida: se è scaduta, la verifica dell’identità avviene nella stessa scheda e conserva il motivo. Occorre aggiornare l’anteprima e confermare personalmente.

La finestra Admin dura 30 minuti; l’anteprima del recupero dura al massimo 5 minuti e resta legata a utente, sessione, chiave, messaggio, tentativo e prova. Una conferma Admin più lunga non rinnova una decisione scaduta.

Se la risposta del salvataggio non arriva, il pulsante di conferma resta bloccato. **Verifica prova ed esito dello stesso tentativo** rilegge il risultato persistito. Il riferimento del comando e l’impronta consentono di riconoscere la stessa riconciliazione dopo riapertura. Non è necessario ripetere l’invio.

**Accettata dal server SMTP** significa che il server ha risposto positivamente al contenuto. Non attesta la consegna nella casella o la lettura del destinatario. **Non inviata · osservazione autorevole** richiede un rifiuto definitivo o una conclusione certa prima dell’invio del contenuto. Un successivo invio richiede comunque una nuova anteprima e una nuova decisione personale; il recupero non lo avvia.

Se manca una prova autorevole, l’esito resta incerto e il blocco viene conservato. Questo vale anche per tentativi storici anteriori al registro delle osservazioni, se privi di una fonte qualificata. Una casella vuota, l’assenza di una ricevuta o la scadenza della sessione non provano un mancato invio. La prenotazione senza claim resta indicata esplicitamente come priva di avvio attestato e non viene convertita in un esito SMTP.

Commerciali e tecnici consultano soltanto le comunicazioni ammesse dal proprio contesto; il comando di riconciliazione è riservato all’Admin corrente. La riconciliazione non modifica destinatari, concessioni o contenuti, non attribuisce al recuperante la decisione del mittente e non modifica la ricevuta originale.

## Conservazione e verifiche tecniche

Il trasporto registra una sola osservazione definitiva per tentativo nello storage documentale privato. Il file contiene riferimenti e impronte della decisione, esito, fase SMTP, codice e istante; non contiene destinatari, messaggio, trascrizioni SMTP o credenziali. È legato alla capacità privata del claim, scritto senza sovrascrittura e sincronizzato prima della conclusione della transazione del trasporto. Una risposta incerta non genera una prova definitiva. Se anche questa registrazione fallisce, il sistema non inventa l’esito.

Il recupero controlla la sessione Admin e i permessi attuali, il contesto e la versione, la scadenza del claim, l’integrità e il legame della prova. Una conferma persiste atomicamente una riconciliazione, un evento e un audit; lo stesso comando produce lo stesso risultato. Una motivazione diversa non può riusare il medesimo comando. Il browser non sceglie l’esito né carica prove arbitrarie.

La migrazione additiva schema75 introduce OrdinaryEmailReconciliation e i suoi vincoli append-only. Le righe storiche non vengono riscritte. Per un precedente UNCERTAIN, la ricevuta originale resta immutabile e il lettore espone l’esito effettivo con il riferimento alla riconciliazione. Nessuna autorità, canale o provider viene attivato dalla migrazione.

Il rilascio richiede candidato e CI esatti, riesame indipendente, backup/ripristino di database e storage privato e piano esecutivo qualificato. Il ritorno applicativo deve includere i lettori delle ricevute riconciliate e il registro delle osservazioni; il solo binario storico non è un ritorno compatibile. La qualificazione del ritorno conserva la nuova tabella e sospende l’editor di recupero, senza cancellare prove o annullare esiti.

Il rilievo COM-023 proveniva da un audit statico: non identifica un incidente SMTP reale. Le prove sintetiche di implementazione e recupero non attestano l’esito di un messaggio reale.
