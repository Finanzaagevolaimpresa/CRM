# Calendari personali e lettura delle notifiche

## Notifiche

**Notifiche → Attive → Apri** registra la lettura della persona autenticata prima di aprire la destinazione autorizzata. Il contatore e l’elenco usano lo stesso filtro, anche per gli avvisi ricavati da task, richiami, offerte e assegnazioni. Un secondo clic conserva la prima ricevuta. La lettura non completa il task e non toglie il lead dalla sua coda.

**Lette** conserva gli avvisi con la ricevuta personale e ricontrolla l’accesso alla scheda. La chiusura di un’attività conserva la lettura; la revoca dell’accesso impedisce di consultare il suo contenuto. Un richiamo con una nuova scadenza costituisce una nuova occorrenza. Gli avvisi di aggiornamento e i promemoria conservano anche le rispettive ricevute native.

## Calendari

Ogni referente salva le proprie fasce in **Calendari → Le mie fasce**. L’Admin può scegliere l’utente da visualizzare. Il calendario include i richiami e le videochiamate già registrati nel CRM. Il profilo tecnico vede le proprie fasce e gli orari dei propri appuntamenti senza nomi o schede Lead.

La setter apre **Appuntamento** nella scheda Lead, sceglie referente, data e durata. Prenotazione, spostamento e annullamento aggiornano la medesima prossima azione della scheda. Il controllo usa il fuso `Europe/Rome`, rifiuta gli orari ambigui del cambio d’ora e serializza le prenotazioni concorrenti della stessa persona. Gli appuntamenti precedenti non ancora collegati al calendario occupano per prudenza 30 minuti.

Una prenotazione interrompe i solleciti individuali in attesa. Anche **Registra chiamata → Videochiamata fissata / Rinviata** usa il medesimo comando di prenotazione di **Appuntamento**, con referente, data e durata espliciti. Chiamata, primo contatto SLA, appuntamento e prossima azione sono salvati in una sola transazione. Un conflitto lascia invariati questi dati e mantiene i campi nel modulo per correggere l'orario. Gli esiti **Svolta** e **Assente** aggiornano il collegamento esistente.

Anche la pipeline commerciale e l'aggiornamento generico con destinatari conservano la data di una videochiamata, compresa quella storica ancora priva di collegamento: note e priorità restano modificabili, mentre cambiare o cancellare la data rimanda al pannello **Appuntamento**. Il campo della pipeline dichiara Europe/Rome. Un valore invariato conserva l’istante già registrato, compresi secondi e cambio d’ora; un nuovo orario ambiguo o inesistente viene rifiutato.

## Google Calendar

**Collega il mio Google Calendar** avvia il consenso personale soltanto quando l’integrazione è configurata e autorizzata. Il collegamento usa il calendario primario dell’account Google scelto e ne verifica i diritti di scrittura. Lo stato OAuth è monouso, scade dopo dieci minuti ed è legato alla sessione CRM; lo scambio usa PKCE. I token sono cifrati con AES-256-GCM e associati alla persona e al loro scopo. Non sono inviati al browser né inseriti nei log.

Il connettore legge libero/occupato e mantiene un ID evento deterministico per ciascun appuntamento. Spostamenti e annullamenti riusano quell’ID; una nuova prenotazione dopo un annullamento riconciliato usa una nuova generazione. Il recupero di un esito incerto legge prima l’evento già identificato. Non vengono aggiunti invitati. Le richieste Google usano `sendUpdates=none`: le comunicazioni ai contatti restano nel percorso email autorizzato. [Disponibilità Google](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query), [creazione eventi](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [aggiornamento con ETag](https://developers.google.com/workspace/calendar/api/v3/reference/events/update), [annullamento](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete).

La scheda distingue **Salvato nel CRM**, **sincronizzazione in attesa**, **sincronizzato**, **errore** ed **esito da riconciliare**. In assenza di Google il calendario rimane locale. Se un calendario è già collegato ma libero/occupato non è verificabile, una nuova prenotazione viene rifiutata. Google non offre una transazione atomica fra libero/occupato e creazione: gli eventi inseriti contemporaneamente da applicazioni esterne richiedono riconciliazione.

Uno spostamento che interseca il vecchio orario verifica anche gli eventi della fascia, scorrendo tutte le pagine restituite. Esclude soltanto l’evento con ID e marcatore del medesimo appuntamento, dopo averne controllato l’ETag; un altro evento occupato, anche interamente sovrapposto, continua a impedire la prenotazione. Dati incompleti o letture non coerenti mantengono il controllo chiuso. [Elenco eventi Google](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

La configurazione richiede `FEATURE_INTEGRATIONS_ENABLED=true`, `GOOGLE_CALENDAR_INTEGRATION_MODE=enabled`, `GOOGLE_CALENDAR_OAUTH_CLIENT_ID`, `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET`, `GOOGLE_CALENDAR_OAUTH_REDIRECT_URI` e `GOOGLE_CALENDAR_TOKEN_KEY` (32 byte in Base64). Il callback deve appartenere a `APP_ORIGIN` e avere percorso `/settings/integrations/google-calendar/callback`. Le impostazioni mancanti mantengono il collegamento disabilitato. L’abilitazione e i valori reali richiedono la separata autorizzazione di rilascio. [Protocollo OAuth Google](https://developers.google.com/identity/protocols/oauth2/web-server).

## Prove e limiti della consegna

`tests/personal-calendar.test.ts` verifica fasce e cambio d’ora, contratto HTTP Google, ripetizione, spostamento anche sovrapposto al vecchio orario, annullamento, esito incerto, cifratura e isolamento delle letture. `tests/personal-calendar-db.test.ts` usa esclusivamente un database marcato sintetico e verifica persistenza, permessi, concorrenza, lettura idempotente, saturazione oltre 500 avvisi e callback OAuth con trasporto simulato. Il percorso browser Lead Setter apre un avviso, verifica il decremento, riapre la ricevuta in **Lette** e conserva il lead nella coda. `tests/personal-calendar/calendar.spec.ts` collauda prenotazione, spostamento, annullamento, fasce personali, calendario Admin e riservatezza del profilo tecnico, anche su schermo mobile.

Le prove con trasporto simulato non attestano il collegamento al calendario Google reale di Ivo. Quel consenso personale, il calendario di prova Google e la configurazione autorizzata restano necessari per il collaudo del provider reale.

La regressione PR263-R2 in `tests/lead-setter/calendar-persistence.ts` confronta i due ingressi sullo stesso slot occupato CRM e Google, rifiuta anche il rinvio occupato e la connessione mancante, verifica gare fra setter e pannello su schede diverse e sulla medesima scheda, replay, prima risposta unica e storico immutabile. La sincronizzazione simulata perde deliberatamente una risposta, riconcilia prima di riprovare e verifica un solo evento esterno durante spostamento e annullamento. Una ricevuta storica può essere riletta; un nuovo comando VIDEO privo del calendario non viene ammesso. Il browser `tests/lead-setter/flow.spec.ts` prepara una fascia occupata dal pannello, prova il diniego nella telefonata e conserva il testo prima del nuovo salvataggio in una fascia libera. La sua esecuzione è affidata alla CI Linux, senza collegamenti reali.

Qualificazione locale del mandato 26 novembre 2026: 8 prove pure e 7 prove di persistenza superate sul database sintetico con schema 78 e Node 22.23.5. Il browser locale non è stato qualificato: `BROWSER_LAUNCH_APPROVAL_PENDING`. La prova Playwright resta affidata al workflow Linux **Operational Flow**; nessun profilo reale è stato impiegato.
