# M4 — Comunicazioni esatte approvate e canale email manuale

Le letture delle comunicazioni e della loro amministrazione ripetono l'intera transazione per al massimo tre tentativi totali soltanto dopo un aborto PostgreSQL accertato (`P2034`, `40001`, `40P01`). Ogni tentativo rilegge sessione, permessi e perimetro; dinieghi, errori di connessione ed esiti incerti non vengono ripetuti. La correzione deriva dal deadlock tra lettura admin e operatore riprodotto nella CI `36327928080` e da una regressione che forza il medesimo ciclo di lock. Non estende la ripetizione a preparazione, approvazione, invio o altre scritture.

Il percorso si apre dalla pratica M2 (`PracticeReadiness`) o dalla pratica tecnica già esistente. Commerciale e tecnico preparano la bozza; soltanto un admin attivo con sessione corrente e conferma privilegiata può approvare la fotografia esatta. L'approvazione del dossier e le vecchie note non sostituiscono questa approvazione.

La fotografia lega canale, pratica/cliente, casella e revisione, mittente, Reply-To, A/CC/BCC, oggetto, testo e versioni/hash/dimensioni degli allegati. Ogni modifica crea una versione immutabile nuova e torna a bozza. Le vecchie approvazioni rimangono conservate ma non autorizzano la nuova versione. Reclami e caselle riservate restano admin; un aggiornamento non può abbassare la riservatezza dello storico. Una casella diventata riservata non può tornare pubblica attraverso questa configurazione.

## Primo canale: email esterna manuale

`Prepara invio manuale e scarica` ricontrolla in transazione sessione, permessi, ambito della pratica, servizio sospeso, mittente, responsabile della casella, sessione/ruolo dell'approvatore e bytes reali degli allegati. Produce un ZIP deterministico con messaggio, destinatari e materiali esatti e apre un unico tentativo `SENDING`. Il browser verifica l'hash prima del download. Non chiama un provider e non invia email.

L'operatore usa il proprio client email già qualificato e registra una dichiarazione manuale (`SENT`, `NOT_SENT` o `UNCERTAIN`). Il CRM non può garantire cosa una persona modifica o invia nel client esterno: l'evidenza resta esplicitamente dichiarativa, mai “consegnata/letta”. Il pacchetto riporta un riferimento CRM che può essere conservato negli header del client; in sua assenza le risposte entrano nella coda di riconciliazione.

Lo stesso requestId riprende il medesimo pacchetto/tentativo, senza creare un altro invio. Un requestId diverso è respinto durante `SENDING` e `UNCERTAIN`. L'incertezza richiede una ricevuta di riconciliazione admin prima di un nuovo tentativo. L'errore accertato permette un nuovo tentativo della stessa versione, soggetto a tutti i controlli freschi. Non esistono retry in background, dispatcher, worker o invio WhatsApp nativo.

## Caselle e risposte

La migrazione registra soltanto i sette indirizzi dichiarati, senza provider, responsabili, capacità, test o abilitazioni. La UI mantiene separati registrato/configurato/collaudato/abilitato. La configurazione salva soltanto riferimenti non segreti, tipo casella/alias/inoltro, destinatario canonico e responsabile. Test e abilitazione sono attestazioni amministrative di prove esterne della stessa revisione; la UI non simula una prova email. Reclami/admin sono sempre riservati. Alias e casella canonica devono avere uguale riservatezza; la revisione canonica è vincolata e le sue modifiche bloccano gli alias da riqualificare.

L'acquisizione manuale di una risposta non è una nuova approvazione in uscita. Una relazione automatica richiede un riferimento CRM esatto già utilizzato in un tentativo, mittente pertinente e casella canonica coerente. Gli altri casi restano in una coda admin. Message-ID e casella canonica deduplicano alias/inoltri; un contenuto diverso sullo stesso identificativo è respinto. La riconciliazione esplicita conserva ricevuta, testo originale e motivo. Gli operatori vedono le risposte nella pratica secondo il perimetro corrente; nessuna CC è aggiunta automaticamente.

## Delta dati e ritorno

La sola migrazione nuova è `20260927010000_approved_manual_communications_v1` (49); il prefisso 48 è immutato e vincolato a PR161 `9508d0da1b9642b02609d7431a984ced7b501e2e`. È una transazione additiva con FK, vincoli, versioni/approvazioni/eventi immutabili e indice che ammette un solo tentativo aperto. Non converte o cancella le vecchie `PracticeCommunication`; i vecchi endpoint non approvano né segnano inviati messaggi esterni.

Una precedente applicazione M1/M2/M3 può essere rimessa in servizio conservando schema49 e tutte le nuove righe, ma non offre M4. Nessun down migration o cancellazione dello storico è previsto. Il collaudo dell'immagine verifica il ritorno M1 e la conservazione di caselle, versioni, approvazione, tentativo e risposta sintetici; non equivale a un ripristino completo del VPS. Il piano produttivo deve avere backup corrente schema48 prima della migrazione, copie cifrate sulle destinazioni approvate e prova isolata pertinente, poi riconciliazione schema49 e prova M4.

## Qualificazione e limiti attuali

Controlli mirati previsti: quattro test di contratto; sette casi PostgreSQL (stati, concorrenza, revoche, sospensioni, hash/bytes, rollback di audit, privacy, alias e risposte); prova della pratica M2 nel banco già esistente; Chromium con admin/operatore, chiave step-up sintetica, bytes reali scaricati e riconciliazione; migrazione 48→49 con errore iniettato e prefisso conservato. I risultati sono quelli dei run riferiti nella PR, non dedotti dalla presenza dei test.

Nessuna configurazione/test di casella produttiva è attestata da questo codice. Non sono acquisiti provider, DNS, credenziali, accesso email reale o WhatsApp. L'abilitazione produttiva del primo mittente richiede inventario e prova esterna effettivi. La produzione non viene modificata da questa PR o dai banchi CI. Le liste espongono pagine da 100 messaggi (massimo 200 pagine); gli eventi/reply di ciascun messaggio sono limitati rispettivamente a 200/100, mentre tutte le prove rimangono persistite.
