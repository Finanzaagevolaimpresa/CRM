# Trasporto esistente e qualifica ordinaria — R01

PR192 resta un candidato separato. La action personale di invio usa il collegamento server al trasporto esistente, con disponibilità corrente nell’anteprima e controlli transazionali invariati. Nessun binding, canale reale, worker o scheduler viene attivato. La prova browser TLS sintetica è descritta in ORDINARY_EMAIL_UI_R01.md; esito da attribuire all’HEAD corrente.

## Riferimenti riconciliati

La ricognizione produttiva in sola lettura del 16/10/2026 alle 17:33 UTC ha verificato esclusivamente i metadati: riferimento runtime `R49_EMAIL_DIRECT_20260930_01`, host `authsmtp.securemail.pro` e modalità diagnostica `enforced`. Il codice diagnostico esistente usa TLS465, SNI, verifica del certificato e autenticazione con il mittente `comunicazioni@finanzaagevolaimpresa.it`. La casella M4 deliberata è `register_it` / `M4_COMUNICAZIONI_REGISTER_IT`.

Il resolver ammette soltanto questa combinazione. Non ricava un host dal nome del provider e non accetta configurazione, credenziali o identità da un form. Legge, solo durante un'invocazione server esplicita, i quattro input di trasporto già esistenti: modalità, riferimento, host e `DIRECT_EMAIL_TEST_SMTP_PASSWORD`. Non legge destinatario, chiave di approvazione o ricevuta del diagnostico. Nelle prove la sorgente e il socket sono sintetici; nessun valore di credenziale produttiva viene acquisito o stampato dagli strumenti della delivery.

## Qualifica distinta e vincolata

`OrdinaryEmailChannel.qualificationReference` contiene un riferimento ordinario opaco `ordinary-smtp-v1:<keyVersion>:<HMAC>`. La sua preparazione non scrive la tabella e non certifica il funzionamento del provider. La persistenza/abilitazione richiede una futura operazione autorizzata e auditata, dopo la qualifica del canale. Non ci sono bootstrap, fallback o conversioni automatiche di qualifiche M4/diagnostiche.

Il riferimento vincola persona tramite i controlli separati già esistenti e, per il trasporto, casella/indirizzo, provider, configurazione M4, revisioni di casella e canale, riferimento runtime, host, TLS465/certificato/TLS1.2, riferimento della credenziale e suo valore corrente. Il valore segreto entra soltanto in un HMAC con dominio distinto e chiave nativa attiva: non si salva un hash semplice della password. La versione della chiave entra nel riferimento. Una rotazione rende necessaria una nuova qualifica esplicita; non la si ricostruisce automaticamente al momento dell'invio.

Il riferimento persistito fa già parte dell'intento MIME approvato e firmato. Una nuova revisione/qualifica invalida la precedente anteprima. Lo schema candidato resta invariato: sei tabelle fuori dalla catena Prisma, nessuna nuova colonna o migration in questo delta.

## Prenotazione e DATA

Il collegamento nativo ottiene sessione/cookie/step-up/chiave dal server e usa il connettore Node TLS. Il resolver controlla il trasporto dentro l'ammissione transazionale, prima di qualsiasi prenotazione, e dopo l'audit immediatamente prima del commit. Una configurazione assente, non qualificata o cambiata annulla decisione, tentativo, stato e audit insieme.

La stessa verifica viene ripetuta sul materiale persistito, sul claim, prima del socket e dentro i lock di autorizzazione DATA, anche dopo la risposta354. Il resolver resta vincolato alla singola revisione della singola invocazione; non può passare a un altro canale. Un cambio della sorgente dopo il commit lascia la ricevuta o il blocco di riconciliazione già previsti: nessun retry. L'accettazione250 resta soltanto accettazione SMTP, non consegna o lettura.

La qualifica non sostituisce identità personale, step-up, sessione corrente, perimetro, allegati/versioni, audit atomico, claim unico o scadenze. I controlli esistenti sulla chiave e sul canale tengono i lock nativi. La configurazione di processo viene verificata senza attese fra controllo finale e scrittura del contenuto.

## Prove e residui

Sette nuove prove locali verificano distinzione dal diagnostico, riferimenti esatti, rotazioni, assenza di fallback, limiti, mancata esposizione dei segreti e uso singolo del trasporto. Otto prove PostgreSQL aggiuntive usano decisione/prenotazione/audit effettivi: sorgente non qualificata, invio sintetico completo, assenza/cambi prima della prenotazione, cambio dopo audit con rollback, dopo connessione e dopo354, nuova qualifica con anteprima obsoleta, cancellazione/deadline. Un ulteriore caso verifica disponibilità read-only e rifiuto ammesso quando la sorgente cambia. La suite totale ha 49 casi DB; esiti da attribuire all'HEAD esatto della CI.

UI di invio e browser TLS sintetico sono integrati nel candidato. Restano ricezione autenticata/cursori e riferimenti operativi, qualifica ordinaria reale, autorità sul binding email distinto e piano SQL/target/recuperabilità. Nessun invio reale senza decisione personale sulla versione esatta. PR191 precede l'integrazione; nessun rollback a codice che ignori perimetri o tentativi.
