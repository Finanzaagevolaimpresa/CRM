# Parametri del progetto — R01

L'Admin apre **Modifica progetto e chi aggiornare** dalla scheda ordinaria del
progetto. Il modulo esistente `RecordUpdate` gestisce titolo, stato operativo,
descrizione, investimento, importo richiesto e spese (categoria, descrizione,
importo, stima). Le valutazioni di ammissibilità e i collegamenti sono conservati.
Non consente cancellazioni di spese registrate o transizioni di archivio/cestino.

Il salvataggio mantiene la scelta esplicita di almeno una persona ammessa al
canale CRM esistente, con anteprima, step-up e ricevuta. Non concede accesso né
prepara o invia email dal progetto. Le regole persistenti già attive mantengono
la propria semantica e possono aggiungere i rispettivi destinatari autorizzati.

Il confronto di `Project.updatedAt` e un digest dell'intero insieme delle spese
impedisce di sovrascrivere dati cambiati, anche quando una spesa è stata aggiornata
senza modificare il timestamp del progetto. La transazione serializzabile mantiene
il lock del progetto e il comando UUID già esistente: salvataggi concorrenti,
replay e risposte perse non duplicano aggiunte o avvisi. La lettura dell'esito non
modifica il record. Errori o esiti incerti conservano il blocco del modulo.

Audit e avvisi contengono soltanto etichette dei campi, mai descrizioni, importi
o dettagli delle spese. Se cambia il titolo, l'evento nativo `RECORD_CHANGED`
copre il salvataggio; se cambiano solo i parametri viene richiamata la stessa
funzione della coda esistente con etichetta `profile` e chiave del comando.
Nessuna nuova coda, cron, tabella o migration. Schema 68 invariato.

Le vecchie richieste titolo/stato restano valide e non cancellano i parametri.
Il modulo completo gestisce al massimo 100 spese; oltre il limite restano
disponibili titolo/stato e le letture/notifiche esistenti. Nessun blocco globale
o eliminazione automatica. Questo incremento non completa ancora il passaggio
idempotente alla pratica o i promemoria pianificati.

Qualifica prevista sull'HEAD esatto: 33 prove PostgreSQL Record updates, 31 email
PostgreSQL, 10 browser nativi, regressioni pure, build/typecheck/lint e controlli
dei perimetri. Le prove aggiunte coprono decimali, conservazione delle valutazioni,
concorrenza, modifica concorrente di spese, revoca a sessione aperta, rollback
dell'audit, riapertura e UI desktop/mobile. Solo dati sintetici isolati.
