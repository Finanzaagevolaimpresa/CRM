# Esiti degli incarichi tecnici

Un riepilogo scaduto o cambiato viene rifiutato prima della persistenza. Il messaggio esplicita che quel tentativo non ha modificato incarichi e consente di ricaricare per una nuova anteprima personale. Il pulsante di conferma del vecchio riepilogo resta disabilitato.

La classificazione usa errori tipizzati delle sole funzioni pure di preparazione, chiamate prima di registrare la decisione. Non interpreta stringhe di errore o l'assenza di una ricevuta come prova di fallimento. Un errore sconosciuto durante la conferma mantiene l'identificativo e il percorso di verifica: una decisione non osservata continua a bloccare una nuova conferma. Una risposta persa dopo il commit si riconcilia con l'unica ricevuta già conservata.

La preparazione dell'anteprima è di sola lettura: una sua indisponibilità non viene presentata come una modifica con esito incerto. Sessione, autorità personale, step-up, perimetri correnti, lock, controlli temporali e audit atomico rimangono applicati.

Qualifica: prove pure su scadenza e classificazione, PostgreSQL isolato su assenza di decisione/revisione/audit dopo rifiuto e successivo nuovo riepilogo, browser nativo su rifiuto, riapertura e blocco di un tentativo con risposta non osservata. Restano le prove esistenti di risposta persa dopo commit, due tecnici, revoca e diniego sui documenti. Nessuna nuova SQL o modifica a concessioni reali.

Questa correzione non identifica la causa di un precedente caso reale e non ne ripete la decisione. La riconciliazione di un tentativo reale rimane distinta dalle prove sintetiche.
