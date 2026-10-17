# Email ordinario — persistenza e integrazione R01

Aggiornamento schema51: i modelli e le undici tabelle sono ora nella migration additiva `20261017120000_ordinary_email_v1`, sulla base PR191 rilasciata. I riferimenti sotto al DDL isolato descrivono la fase precedente; quei file restano solo sintetici. Stato e vincoli correnti: [ORDINARY_EMAIL_MIGRATION51_R01.md](ORDINARY_EMAIL_MIGRATION51_R01.md). Nessuna attivazione produttiva deriva dalla migration.

Ricognizione sul candidato PR192, schema50. Questo documento identifica il delta necessario e i vincoli; non è una migration eseguibile e non autorizza SQL produttivo. La prima release lifecycle resta PR191.

## Perché il modello M4 non basta

`CommunicationVersion` conserva contenuti immutabili `EMAIL_MANUAL`. `CommunicationApproval` ammette l'approvazione manuale di un Admin generico e ha un solo record per versione. `CommunicationAttempt` dipende da quella approvazione mediante FK e usa gli stati della dichiarazione manuale. Usare queste righe come autorizzazione SMTP attribuirebbe alla vecchia decisione un effetto nuovo. I record `CommunicationIntentRecord` N15 rimangono `RECORDED/HELD` con i controlli dormienti; non diventano una coda di invio.

Riutilizzare bozze/versioni e accessi M4 è utile. Occorre invece una persistenza additiva distinta per autorità email, qualifica ordinaria del canale, decisione personale e tentativo. Prima di introdurre una migration nella catena Prisma bisogna riconciliare PR191 e adeguare le verifiche del numero di migration; non modificare i checksum delle cinquanta esistenti.

## Oggetti e invarianti da implementare

| Oggetto proposto | Dati e vincoli necessari |
| --- | --- |
| Autorità email | Identità `ordinary-email`, scopo `ORDINARY_EMAIL`, FK persona e casella esistenti, revisione, abilitazione inizialmente falsa. Nessuna riga reale o elevazione automatica nel DDL. Un binding project-sharing non soddisfa questo requisito. |
| Qualifica ordinaria del canale | FK casella, revisione esatta, provider/configurationRef canonici, protocollo qualificato, riferimento della prova, revisione della qualifica, abilitazione inizialmente falsa. `MANUAL_EXTERNAL` e diagnostica non sono qualifiche ordinarie. Non memorizzare secrets nella ricevuta. |
| Decisione personale | ID dell'anteprima univoco; FK versione immutabile e attore; sessione, revisioni di autorità/casella/canale, hash bozza/intento/MIME/contesto, data di preparazione e approvazione, scadenza, versione chiave e prova firmata. Append-only, nessuna cancellazione in cascata. |
| Tentativo ordinario | FK decisione univoca, chiave richiesta univoca, riferimento messaggio stabile, hash MIME, stato e tempi. Vincolo sul messaggio che impedisca un secondo tentativo mentre è prenotato, incerto o accettato. Un nuovo requestId non sblocca l'invio. |
| Esito e ricevuta | Esito append-only autenticato e riferito al tentativo. `ACCEPTED` significa accettazione SMTP; non implica consegna o lettura. `UNCERTAIN` resta bloccante fino a riconciliazione, senza retry automatici. |
| Ingresso automatico | Identità univoca casella/protocollo/UIDVALIDITY+UID o equivalente riferimento provider, hash contenuto e stato di associazione. Nessuna falsa attribuzione a un utente che avrebbe acquisito manualmente la risposta. Un duplicato diverso è conflitto. |

Il candidato isolato ora implementa sei tabelle per autorità, qualifica, decisione, tentativo, consumo ed esito: vedere `ORDINARY_EMAIL_STORE_CANDIDATE_R01.md`. Il DDL completo è vincolato fisicamente al database sintetico e resta fuori dalla catena Prisma. Ingresso automatico, promozione a migration applicativa e integrazione restano da completare. Le cancellazioni definitive, conversioni di righe M4 e scritture di bootstrap reali non fanno parte del candidato corrente.

## Transazione di «Approva e invia»

1. Ricavare attore e cookie dalla sessione server; acquisire i lock autorevoli di utente/sessione e verificare ruolo e permessi correnti. Caricare e bloccare l'autorità email distinta e la qualifica del canale; la persona canonica è un riferimento, mai un confronto del nome visualizzato.
2. Acquisire i lock del contesto tramite le guardie M4 riconciliate con PR191. Archivio/cestino, perimetri selettivi, revoche, scadenze e vincoli finanziari/documentali devono essere correnti. Il contesto autorizzato determina `contextHash`; non accettarlo dal browser come autorità.
3. Bloccare il messaggio e verificare revisione/hash della bozza, assenza di invii manuali o ordinari concorrenti, qualifica casella e versioni degli allegati. Rileggere i byte autorizzati e verificarne gli hash. La bozza M4 non concede da sola un invio SMTP.
4. Con l'orologio del DB verificare anteprima e step-up nativo tramite il contratto personale; ricalcolare esattamente il MIME alla data preparata. Registrare decisione, prenotazione unica e audit nella stessa transazione. Non effettuare alcuna chiamata di rete dentro la transazione o nei suoi retry. Ricontrollare scadenze sul clock DB dopo attese e audit.
5. Solo dopo commit certo, un adattatore server privato può acquisire una volta il tentativo prenotato, ricontrollando autorità, contesto e scadenza prima della connessione. La ripetizione della richiesta, la perdita della risposta al commit o un errore di lettura dello stato non sono permesso di aprire un altro socket.
6. Il trasporto non conserva un lavoro ritentabile automaticamente. Quando DATA potrebbe essere passato al server e manca la risposta certa, registrare un esito incerto; se anche la persistenza dell'esito fallisce, la prenotazione già committata resta bloccante. Un mancato invio certo richiede una nuova decisione personale prima di un nuovo tentativo.

Un cambio della bozza invalida tutte le decisioni precedenti tramite i riferimenti alla versione; non riscrive la storia. Anche il ponte manuale deve rispettare la prenotazione ordinaria dello stesso messaggio, evitando due percorsi concorrenti.

## Audit realmente conservato

Il minimizzatore nativo elimina chiavi contenenti `message`, `email`, `content`, `token` e molte altre; `operation` non rientra nella lista ammessa. Non usare un payload pre-trigger come prova dell'audit. Il collegamento al messaggio M4 può risiedere in `AuditLog.entityId` con il tipo già protetto dai controlli di visibilità, mentre il payload minimale può usare `action`, `status`, `decisionId`, `attemptId`, `evidenceHash`, `stateVersion`, `authorityVersion`. Tutti i valori effettivamente mantenuti devono essere confrontati in PostgreSQL dopo il trigger. Non copiare corpo, indirizzi, destinatari, token o byte degli allegati nell'audit.

## Prove e limiti prima dell'integrazione

La qualifica DB isolata deve coprire vincoli reali e due connessioni concorrenti: audit fault con rollback completo, replay con requestId diverso, bozza/canale/autorità cambiati, sessione o step-up scaduti durante un lock, sospensione lifecycle concorrente, revoche, mutazione degli allegati, tentativo manuale concorrente, commit incerto e stato bloccante dopo errore di esito. La UI dovrà esercitare ricevuto → associazione → bozza → modifica/rifiuto/approvazione personale → esito, senza invii esterni.

Nessun host IMAP/API viene derivato dal nome Register.it. Ricezione automatica, autenticazione del canale, persistenza del cursore e policy di elaborazione vanno qualificate sui riferimenti realmente disponibili. Nessuna nuova credenziale o provider è introdotta. La decisione personale su una versione non autorizza messaggi successivi.

Il contratto `ordinary-email-decision.ts`, la sequenza isolata `ordinary-email-smtp-candidate.ts`, lo store e il servizio candidato sono implementati. Il servizio mantiene i lock nativi durante DATA senza ritentare il callback, dopo il consumo unico già committato; la scadenza è ricontrollata dopo354. La suite PostgreSQL include49casi e collega il servizio a un socket sintetico, osservando anche le attese reali delle revoche concorrenti. Dipendenze server e UI sono collegate, con prova TLS sintetica nel browser. Restano qualifica del canale reale, binding autorizzato e ricezione autenticata. Nessuna migration produttiva, attivazione, binding reale o invio esterno è eseguito da questo candidato.
