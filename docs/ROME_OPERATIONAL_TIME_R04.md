# Orari operativi Europe/Rome

I moduli degli incarichi tecnici e delle pratiche ordinarie espongono il fuso
Europe/Rome anche quando il dispositivo ha un fuso diverso. La scadenza di un
accesso rimane distinta dalle date di lavoro, presentazione e aggiornamento.

Un istante già salvato viene formattato per Roma senza modificarlo. Un invio
del modulo che non modifica quel campo conserva anche secondi e millisecondi.
La scelta di un nuovo orario viene risolta in un istante ISO esplicito prima
dell'anteprima e dei controlli server già esistenti. Non cambia il contratto
di autorizzazione, la scadenza massima dell'incarico o la firma dell'anteprima.

L'ora inesistente durante il passaggio all'ora legale viene rifiutata. Quando
l'ora si ripete al ritorno all'ora solare, la persona sceglie esplicitamente
la prima o la seconda occorrenza. Una modifica a un altro campo non cambia
l'occorrenza già persistita.

La CI usa browser con fusi America/New_York e Asia/Tokyo, verifica l'istante
effettivo in PostgreSQL, il riepilogo, la riapertura, l'audit e il rifiuto degli
orari ambigui senza una scelta. Le fixture sono isolate; nessun dato reale
viene spostato o corretto. I test puri coprono inverno, estate, cambio giorno,
date impossibili e transizioni dell'ora legale.

L'incremento non introduce migrazioni, scheduler o concessioni. Le regole dei
promemoria PR234 restano separate. Non converte indiscriminatamente i campi
che rappresentano soltanto una data civile nei moduli estranei al flusso tecnico.
