# Ricezione ordinaria: candidato isolato

Aggiornamento schema51: i modelli e le undici tabelle sono ora nella migration additiva `20261017120000_ordinary_email_v1`, sulla base PR191 rilasciata. I riferimenti sotto al DDL isolato descrivono la fase precedente; quei file restano solo sintetici. Stato e vincoli correnti: [ORDINARY_EMAIL_MIGRATION51_R01.md](ORDINARY_EMAIL_MIGRATION51_R01.md). Nessuna attivazione produttiva deriva dalla migration.

Il candidato aggiunge acquisizione privata con cursore e associazione derivata, senza route, scheduler, connettore predefinito o casella attivata. La ricezione non dipende dalla sessione di Antonio e non richiede conferme per ogni messaggio. La successiva decisione personale di invio rimane distinta.

## Riuso e modello

M4 conserva già risposte immutabili in `CommunicationReply`, eventi e letture ammesse dal contesto. Il suo inserimento manuale non autentica un canale automatico e non dispone di cursori. N15 conserva intenzioni/decisioni di comunicazione e la business inbox appartiene al ciclo lead: riusarle per una casella introdurrebbe semantiche, dispatch e dipendenze estranei.

`inbound-candidate.sql` aggiunge cinque tabelle solo nel database sintetico, dopo le sei tabelle del candidato uscita. Nessun delta Prisma. Il DDL richiede nome/sentinel del database effimero, schema50 e base ordinaria presente; nessuna riga o binding iniziale. Sono preservati tutti i riferimenti tramite RESTRICT e prove immutabili. Non è una migration produttiva.

- Stream: casella/revisione canonica, protocollo, endpoint TLS, cartella e generazione immutabili; qualifica distinta, scadenza, cursore e versione CAS. Una nuova generazione richiede riconciliazione esplicita, nessun reset automatico.
- Batch: ricevuta immutabile della transizione del cursore e impronta del lotto.
- Item: identità stabile del provider entro lo stream, payload normalizzato e impronta immutabili.
- Conflict: hash divergente con riferimento al lotto; conserva l'originale e non duplica lo stesso conflitto.
- Link: una sola proiezione verso la risposta M4 dopo ammissione del contesto corrente.

## Confine autenticato e concorrenza

La factory privata richiede un adattatore server `readAuthenticated`. L'implementazione IMAP separata verifica TLS/SNI, autentica la casella e legge senza segnare/eliminare messaggi. Non legge variabili d'ambiente, non sceglie endpoint o credenziali e non viene attivata da una route o da uno scheduler. La qualifica sintetica del protocollo non costituisce qualifica della casella reale.

La qualifica HMAC è vincolata a stream/casella/revisioni, descrittore, scadenza, chiave nativa e credenziale corrente. Preparare l'impronta non qualifica o abilita il canale. Nessun fallback M4/SMTP. Credenziali mai persistite, esportate o registrate in audit. Solo la fonte privata genera una capacità locale consumabile una volta; JSON, flag `authenticated`, oggetti copiati e replay non sono ricevute autenticate.

Una lettura limitata (15 secondi, 25 elementi, 2 MiB normalizzati) precede una transazione unica. La transazione ricontrolla chiave nativa, casella, qualifica, scadenza e posizione, poi inserisce elementi/conflitti, ricevuta e audit insieme al cursore. I duplicati identici non creano risposte. Due letture dello stesso cursore hanno un solo vincitore. Errori di audit non avanzano il cursore; esito di commit incerto non viene ritentato automaticamente. La lettura successiva deve riacquisire la posizione corrente. Nessun messaggio viene cancellato o confermato al provider.

Il percorso MIME privato accetta byte RFC822 solo dal confine autenticato già qualificato. Il connettore deve fornire la dimensione integrale dichiarata dal server e un istante di ricezione stabile: né l'header Date né l'ora del fetch determinano la ricezione. Protocollo concreto, semantica della paginazione e recupero dopo cambio generazione restano da qualificare sul canale deliberato.

## MIME e allegati privati

La factory aggiuntiva usa postal-mime 4.0.7, fissato nel lockfile, per decodificare header, charset, quoted-printable e base64. Prima del decoder tollerante verifica la struttura MIME: separatori header/corpo, header strutturali singoli, chiusura di ogni multipart, encoding e limiti. Ammette multipart mixed/alternative/related; gli altri contenitori e gli encoding non supportati negano il lotto intero. Nessun troncamento, acquisizione parziale, retry o avanzamento del cursore su errore.

Limiti espliciti: 25 messaggi, 1 MiB di byte originali complessivi per pagina e per messaggio, 64 parti, profondità 12, 32 KiB di header per parte e 64 KiB complessivi, 32 allegati. Resta il tetto esistente di 2 MiB normalizzati per lotto. Un messaggio oltre i limiti richiede una successiva procedura deliberata; non viene saltato automaticamente.

Il payload immutabile conserva privatamente i byte originali in base64, dimensione e SHA256, più un manifesto degli allegati con ordine, nome originale, tipo dichiarato, disposizione, Content-ID, dimensione e SHA256 dei byte decodificati. I nomi non diventano percorsi sul filesystem e il tipo dichiarato non attesta sicurezza del contenuto. Gli allegati non vengono aperti, decompressi, eseguiti o promossi automaticamente a documenti CRM. I messaggi RFC822 allegati rimangono opachi e non possono fornire riferimenti o testo al messaggio esterno.

Solo il testo semplice può essere proiettato nel contesto ammesso; HTML e risorse esterne non vengono renderizzati o richiesti. Un messaggio solo HTML rimane conservato nell'area privata senza proiezione M4, come i messaggi non associabili. La proiezione usa campi espliciti e non trasferisce originale o header privati in risposte, audit o eventi. Gli allegati rimangono esclusi dalla nuova bozza.

La pagina nativa mostra nome e dimensione degli allegati solo dopo l'ammissione del contesto, dei documenti e dell'item non in conflitto. Essendo materiale non classificato, servono tutti i permessi `document.download`, `document.sensitive.read`, `contract.read` e `payment.read`. Il download usa un POST con origine/sessione correnti e hash esatti del payload e del file. La transazione rilegge il contesto, mantiene i lock, ricostruisce il manifesto dai byte originali, registra un audit minimizzato e verifica la scadenza con clock DB prima di restituire i byte. Errori o revoche non restituiscono contenuto parziale. Risposta come attachment/octet-stream, nosniff, sandbox e no-store; nessuna anteprima attiva. Una GET non scrive. Il download non importa il file nel patrimonio documentale né concede una declassificazione.

## Adattatore IMAP esplicito

`ordinary-email-inbound-imap.ts` implementa soltanto IMAP su TLS verificato con password della casella, cartella INBOX e UIDVALIDITY numerica già deliberata. Richiede un cursore iniziale esplicito: non sceglie automaticamente di importare lo storico o saltarlo. Le sole operazioni sono LOGIN, EXAMINE, UID FETCH dei metadati, UID FETCH BODY.PEEK[] e NOOP; nessun SELECT scrivibile, STORE, EXPUNGE, APPEND o modifica dei flag.

EXAMINE deve confermare READ-ONLY, UIDVALIDITY attesa e UIDNEXT. Il cursore è l'ultimo UID interamente coperto. Una pagina copre al massimo 25 posizioni UID, inclusi i buchi di messaggi già rimossi, fermandosi a UIDNEXT-1 della fotografia corrente. Prima dei corpi vengono verificati UID, RFC822.SIZE e INTERNALDATE; i byte integrali devono avere la dimensione dichiarata. INTERNALDATE è la data stabile della ricezione, non l'header Date controllabile dal mittente. Una casella senza nuovi UID produce IDLE senza ricevuta, batch, audit o avanzamento. Cambio generazione, TLS non valido, risposta ambigua, messaggio oltre limite, interruzione o timeout negano il lotto senza riconnessione automatica. Le password non rappresentabili nel sottoinsieme LOGIN supportato vengono negate prima del collegamento.

La suite offline copre framing frammentato, ordine degli attributi, cursor/gap, limiti, autenticazione negata, generazione modificata, abort e assenza di riconnessioni. CI aggiunge tre prove con server TLS su loopback: CA valida, CA non fidata e nome non corrispondente. La CA è effimera, ammessa dal solo test; non viene abbassata la verifica del certificato. Queste prove non contattano Register.

Le impronte comprendono l'intero originale: cambiare soltanto un allegato genera un conflitto, conserva la prima versione e nasconde anche una risposta precedentemente associata. Duplicati esatti restano idempotenti. Nessun valore JSON può sostituire la qualifica del canale o la ricevuta privata monouso.

La qualifica MIME aggiunge dieci casi unitari e quattro casi PostgreSQL (75 totali nella suite dedicata): originali privati e proiezione esplicita, conflitto del solo allegato, pagina non valida senza scritture e conservazione privata dei non associabili/HTML. Gli esiti valgono solo dopo l'esecuzione sul nuovo HEAD; i 71 casi del candidato precedente non ne costituiscono prova.

## Associazione e visibilità

L'acquisizione automatica non crea utenti, sessioni, concessioni o approvazioni. I nuovi item non compaiono nell'amministrazione M4, ricerca, contatori o esportazioni. L'associazione privata deriva il messaggio solo dal riferimento SMTP esatto, controlla ricevuta ACCEPTED della versione e destinatario pertinente della stessa casella, quindi applica i controlli nativi dell'utente corrente su pratica, progetto, documenti e vincoli finanziari. Nessun ID nel testo o indirizzo coincidente basta da solo.

Solo dopo tali verifiche viene creata la risposta M4; audit, link ed evento sono atomici. Lettura ordinaria senza nuovo step-up; né tale lettura né l'associazione consentono invii. Archivio, cestino, sessione revocata, documenti esclusi e perimetro selettivo continuano a negare. Un conflitto successivo nasconde la risposta già associata dalle nuove letture senza cancellarne l'originale. I lock dell'item serializzano conflitto e lettura.

La pagina comunicazioni offre «Collega risposte ricevute» sul messaggio con ricevuta ACCEPTED. L'action usa sessione/origine native, senza step-up, e rilegge versione e perimetro prima di individuare candidati. Solo riferimenti esatti e partecipanti della stessa casella arrivano al lotto di 25 elementi; nessuna inbox globale, conteggio di esclusi o chiamata al provider. Tutti i link e audit del lotto sono atomici. Il controllo di concorrenza resta sul messaggio e sugli item; risposta persa richiede rilettura, nessun retry automatico. Nessuna GET scrive collegamenti.

«Prepara risposta» apre una nuova bozza nel contesto ammesso, mostrando il testo ricevuto come testo non attendibile. Mittente, destinatari, testo e allegati restano da compilare esplicitamente; nessuna approvazione ereditata. Il salvataggio controlla di nuovo sorgente/hash, contesto, documenti, riservatezza, sessione e conflitti, mantiene il riferimento nell'evento M4 e verifica scadenza con clock DB dopo audit. La bozza segue poi anteprima e decisione personale proprie. Il collegamento è una fonte di lavoro: non afferma threading RFC dell'email uscente o inoltro automatico del messaggio ricevuto. Attivazione e qualifica della ricezione effettiva, importazione ammessa degli allegati, rappresentazione ammessa dei messaggi solo HTML e riconciliazione dei non associabili restano residui.

## Qualificazione e recuperabilità

Unità: `node --import tsx --test tests/ordinary-email-inbound.test.ts` (nove casi), inclusa compatibilità dei riferimenti manuali M4 senza tabelle candidate. PostgreSQL: quindici casi aggiuntivi nella suite `tests/ordinary-email/store-db.test.ts`, inclusi CAS concorrente, audit/commit, revoche durante fetch, scadenza durante audit, duplicati/conflitti e associazione ammessa/negata. Le prove concorrenti osservano attese reali dei lock di chiave, canale e progetto prima della revoca. CI verifica DDL senza sentinel/base, rollback atomico del DDL e conteggio schema invariato. Gli esiti vanno attribuiti al singolo HEAD, non al precedente candidato di uscita.

Il seguito UI aggiunge sette casi PostgreSQL (71 totali): limite/pagine, GET senza scritture, riferimenti e accessi correnti, rollback del lotto, risposta persa, bozza senza eredità, conflitto/revoca/expiry e lock. Il nuovo `native-inbound.spec.ts` verifica login nativo, lettore diverso dall'autorità senza step-up, doppio clic, origine/replay, dati privati esclusi, markup non eseguito, selezione revocata, bozza esplicita e rifiuto personale, conflitto con form aperto e sessione/archivio. La sorgente di ricezione e lo storico ACCEPTED di questo scenario usano adattatori simulati; il TLS reale sintetico resta nel distinto scenario invio. Le tre prove browser non qualificano un provider di ricezione reale.

Il seguito allegati aggiunge cinque casi PostgreSQL su bytes/hash/audit, selezioni contraffatte, revoche correnti, rollback/expiry e lock effettivi su conflitto/progetto, più un caso IDLE senza scritture: 81 casi nella suite corrente. Il browser nativo acquisisce MIME sintetico e verifica download effettivo, header, origine, GET, revoca e conflitto con form aperto. Le prove spettano al preciso HEAD eseguito.

La base è riconciliata con PR191 rilasciata. Una verifica operativa separata ha autenticato la casella con la credenziale esistente confermata dal titolare e ha letto EXAMINE su INBOX: TLS verificato, endpoint `pop.securemail.pro:993`, UIDVALIDITY e UIDNEXT osservati senza acquisire messaggi o modificare flag. La ricevuta operativa rimane fuori repository. Questa verifica non abilita lo stream né qualifica invii reali o una lettura produttiva completa.

`ordinary-email-inbound-runtime.ts` collega il trasporto al persister nativo. Accetta soltanto endpoint, protocollo, cartella e riferimento di credenziale deliberati; un host alterato nel database non può ricevere la password. L'ambiente viene riletto a ogni controllo della qualifica HMAC. Il comando `node --import tsx scripts/ordinary-email/receive-once.ts --stream <UUID>` acquisisce una sola pagina dopo tutti i controlli del persister; stampa soltanto stato e contatori tecnici. Non crea/abilita stream, non sceglie il cursore iniziale e non introduce timer o retry. IDLE non scrive nel database. Tre test offline coprono destinazione, credenziale e drift; due prove PostgreSQL aggiuntive verificano l'intero collegamento IMAP/MIME/persistenza e i dinieghi prima del collegamento (83 casi totali). L'esito resta da attribuire al preciso HEAD eseguito.

Prima di integrazione restano autorità email/qualifica reale, scelta del perimetro temporale iniziale, attivazione pertinente e piano SQL/versione/target/recuperabilità. Non usare il DDL di test in produzione. Un ritorno a codice che ignora cursori, conflitti o tentativi incerti non è un rollback sicuro; recuperare con codice compatibile e senza replay automatico.
