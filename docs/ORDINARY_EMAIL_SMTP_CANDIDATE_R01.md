# Email ordinario — adattatore SMTP isolato R01

`ordinary-email-smtp-candidate.ts` implementa la sequenza di protocollo per il candidato PR192, con dipendenze obbligatorie iniettate. Non contiene un connettore di rete predefinito e non è collegato a route, pulsanti, worker o scheduler. Nessuna casella o autorità personale reale è attivata; M4 manuale, diagnostica e N15 restano separati.

## Prima del trasporto

Il modulo ricostruisce MIME e busta SMTP dai materiali versionati con la stessa funzione usata dall'anteprima. I byte e i destinatari sono privati dell'invocazione: una mutazione degli oggetti del chiamante durante un'attesa non li modifica. Chiede a `takeCommittedAttempt` un consumo unico del tentativo già committato, con hash intento, MIME e busta comprensiva di BCC e riferimento esatto del canale. Il callback deve verificare decisione personale canonica, transazione/audit conclusi, contesto e concorrenza manuale/ordinaria. La presenza di un oggetto con `committed: true` non è di per sé una prova: l'autorità deriva esclusivamente dall'implementazione server persistente, ancora da integrare.

Un consumo assente, non confermato, scaduto, riferito ad altro tentativo o con esito di commit ignoto non apre un socket. L'errore non libera un tentativo persistente e non autorizza retry. L'esito `NOT_SENT` del modulo descrive il trasporto di quell'invocazione: non permette di reinterpretare come libero un record con commit/esito ignoto. Le prove di concorrenza di questo incremento usano un registro sintetico in memoria e non sostituiscono PostgreSQL, vincoli univoci o test dell'audit realmente conservato.

`assertCurrent` deve leggere stato autorevole di attore/sessione, autorità email, canale, perimetri e scadenze. È invocato prima della connessione e nuovamente dopo le attese SMTP, anche dopo la risposta al comando DATA e prima dei byte del messaggio. La futura integrazione deve definire e provare la serializzazione rispetto a revoche e lifecycle concorrenti: il callback da solo non dimostra quei lock. `readQualifiedTransport` deve risolvere il solo riferimento qualificato e già autorizzato del tentativo; il codice non inventa un hostname dal provider e non legge file di configurazione, variabili d'ambiente o credenziali reali.

## Sequenza e risultati

Il connettore iniettato riceve porta 465, TLS minimo 1.2, `rejectUnauthorized: true` e SNI pari all'host qualificato. Il modulo verifica anche l'esito TLS e richiede AUTH PLAIN annunciato dal server. Non offre fallback in chiaro o STARTTLS. TLS implicito e verifica del certificato seguono il modello di [RFC 8314, sezione 3.3](https://www.rfc-editor.org/rfc/rfc8314#section-3.3); la compatibilità del canale reale resta da qualificare.

MAIL usa il mittente canonico; RCPT comprende tutti e soli TO/CC/BCC approvati. Il rifiuto di un destinatario chiude il tentativo prima di DATA, evitando l'invio al solo sottoinsieme accettato. Le risposte sono lette in sequenza con limiti di dimensione e multilinea coerente; non sono consentiti pipeline, pool, reconnect o retry. Il contenuto 7 bit usa terminatori CRLF e trasparenza del punto. Una linea MIME oltre il limite supportato viene respinta prima di consumare il tentativo; il rendering di nomi di allegati Unicode particolarmente lunghi resta da estendere prima del flusso completo.

La risposta 250 al termine dei dati è `ACCEPTED`, cioè accettazione SMTP, non prova di consegna o lettura. Un rifiuto esplicito 4xx/5xx è `NOT_SENT`. Perdita della risposta, errore dopo una possibile scrittura parziale o risposta inattesa sono `UNCERTAIN`; nessuno dei tre esiti abilita un reinvio automatico. La distinzione segue la responsabilità di accettazione descritta in [RFC 5321, sezione 4.2.5](https://www.rfc-editor.org/rfc/rfc5321#section-4.2.5). Dopo un risultato definitivo si tenta QUIT; un errore nella sola chiusura non annulla il risultato già acquisito. L'esito restituito contiene soltanto stato, fase e codice numerico, senza corpo, indirizzi o risposta testuale del server.

Il budget globale è al massimo 15 secondi, comprensivo delle attese per consumo e controllo corrente. È un limite conservativo del candidato sincrono, non una qualifica di latenza del provider né una dichiarazione di conformità come MTA generale. Se scade dopo una possibile trasmissione, l'esito rimane incerto e bloccante.

## Prove e residui

Undici prove del nuovo modulo, più le dodici del nucleo/decisione personale, esercitano byte effettivi, BCC, claim mancante/alterato/commit ignoto, richieste concorrenti/ripetute, rifiuto parziale dei destinatari, esiti finali, scrittura parziale, chiusura dopo ACK, risposte frammentate/malformate, parametri TLS obbligatori, timeout, invalidazione dopo DATA e mutazioni durante le attese. Socket e certificazione TLS sono simulati: nessuna connessione TCP/TLS reale o qualifica crittografica del provider viene rivendicata.

Comando: `node --import tsx --test tests/ordinary-email-candidate.test.ts tests/ordinary-email-decision.test.ts tests/ordinary-email-smtp-candidate.test.ts`.

Restano da implementare/qualificare persistenza e audit atomici, binding personale email autorizzato, adapter server dei callback e di configurazione, protocollo/canale reale, ricezione automatica e UI completa. Il trasporto di produzione non può chiamare questo candidato con stub o con la sola approvazione M4. Nessuna migration, secret, provider, sessione impersonata, concessione reale o invio esterno fa parte del delta. Prima dell'integrazione rimane obbligatoria la riconciliazione con PR191.
