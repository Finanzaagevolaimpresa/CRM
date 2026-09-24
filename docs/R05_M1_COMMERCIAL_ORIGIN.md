# R05 M1 — Provenienza commerciale documentata

La scheda cliente collega una pagina separata per chi ha acquisito e chi ha contrattualizzato il cliente. I due riferimenti possono essere diversi, e sono distinti da `Client.salesOwnerId`, `Client.consultantId` e dai responsabili delle singole pratiche. Il CRM non deduce l'origine da un'assegnazione attuale, dal creatore del record o dalla prima risposta N14.

La prima registrazione indica almeno un'identità documentata, un riferimento alla fonte e una motivazione. Un'identità non documentata resta esplicita. Le rettifiche richiedono una nuova motivazione; possono anche ritirare un'attribuzione precedente senza inventare un sostituto. Si conservano prima registrazione e correzioni, autore e data. La fonte è un riferimento dichiarato dall'admin: questo comando non verifica automaticamente il documento indicato.

## Comando e conservazione

Solo l'admin attivo, con sessione del registro corrente e step-up enforced, registra o rettifica l'origine. Il servizio rilegge e blocca sessione/utente e cliente; confronta l'identificativo dell'ultima registrazione visto dal form. Una richiesta obsoleta o concorrente non sovrascrive la precedente. I riferimenti devono appartenere a identità esistenti, anche se sospese, rimosse logicamente o con ruolo successivamente cambiato: sono fatti storici, non nuovi incarichi.

Si riusa `AuditLog`, senza aggiungere migrazioni o una seconda verità sugli owner. Gli eventi sono `client_commercial_origin_recorded` e `client_commercial_origin_corrected`, con snapshot validato `R05_COMMERCIAL_ORIGIN_V1`, revisione e predecessore. Il comando inserisce un nuovo record e non aggiorna né cancella le righe storiche. Registro e audit sono la stessa scrittura atomica. La cronologia è strettamente crescente anche quando l'orologio restituisce lo stesso millisecondo. Un errore di inserimento lascia la versione precedente invariata.

Questa è conservazione applicativa tramite il registro esistente, non uno storage WORM o un vincolo database contro un amministratore del database. Non sono introdotte cancellazione, conservazione automatica o modifiche alle ricevute storiche. Una riga corrente con payload non valido interrompe lettura e rettifica; non viene ignorata per ricostruire una storia alternativa.

## Consultazione

La pagina richiede `client.read` e accesso corrente al cliente. L'identità originaria non ottiene accesso, notifiche, assegnazioni o accettazioni dalla sola registrazione. Revocare una responsabilità corrente interrompe l'accesso anche a questa pagina alla richiesta successiva. I perimetri espliciti della PR151 restano una possibilità indipendente.

La cronologia mostra 25 registrazioni per pagina con cursore vincolato al medesimo cliente; la selezione delle identità ha ricerca e pagine da 25, mantenendo visibili quelle già selezionate. I nomi sono risolti dall'anagrafica corrente, con stato sospeso/rimosso; le identità storiche non più presenti sono indicate come tali. Non si espongono email o directory utenti agli altri operatori.

## Prove

- Contratto puro: dimensioni, motivazione, identità non documentate, campi estranei, nessuna equivalenza con assegnazione/accettazione.
- PostgreSQL sintetico: origine assente anche con owner presente, prima registrazione e rettifica, byte precedenti e owner invariati; sessioni/ruoli/revoche; concorrenza; rollback su fault audit; rimozione logica; cronologia oltre 25 righe; cursore estraneo e snapshot malformato.
- Browser su UI/HTTP reali nelle modalità enforced/disabled: step-up, replay non-admin/obsoleto, salvataggio e riapertura, riassegnazione admin senza mutare origine, negazione al commerciale originario e al precedente owner, rettifica e storia dopo rimozione. Secondo caso verifica pagine successive per cronologia e ricerca identità.

Le fixture sono soltanto sintetiche in CI isolata. Il codice riusa le 48 migrazioni della PR151 senza modificarne i byte. La compatibilità con l'immagine legacy resta `CI_SCHEMA48_COMPATIBILITY_ONLY`, senza ammissione del recupero operativo. Nessun deploy, backup reale, contatto SSH, migrazione produttiva, invio o attivazione è incluso.

M1 rimane parziale: reparti, presa in carico separata e raccordo diretto al servizio acquistato seguono nel programma già autorizzato. Prima risposta N14 e accettazione economica del preventivo non sono una conferma dell'operatore. Il successivo pacchetto Work/report di M2 dovrà riferire questa provenienza senza reinterpretarla come titolarità.

Rischio residuo: la consultazione del registro usa i filtri esistenti su `AuditLog`; non è una qualifica di carico o di conservazione legale. Il rollback del solo delta nasconde la pagina e il nuovo comando ma lascia i record inseriti disponibili nel registro; non ripristina o cambia automaticamente le responsabilità.
