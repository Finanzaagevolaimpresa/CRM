# Ricezione ordinaria: candidato isolato

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

La factory privata richiede un adattatore server `readAuthenticated`. Deve verificare TLS/SNI, autenticare la casella e leggere senza segnare/eliminare messaggi. Non esiste un adattatore IMAP/provider reale già qualificato: nelle prove questo confine è simulato. Non si deve equiparare tale prova al TLS SMTP già collaudato nel browser.

La qualifica HMAC è vincolata a stream/casella/revisioni, descrittore, scadenza, chiave nativa e credenziale corrente. Preparare l'impronta non qualifica o abilita il canale. Nessun fallback M4/SMTP. Credenziali mai persistite, esportate o registrate in audit. Solo la fonte privata genera una capacità locale consumabile una volta; JSON, flag `authenticated`, oggetti copiati e replay non sono ricevute autenticate.

Una lettura limitata (15 secondi, 25 elementi, 2 MiB normalizzati) precede una transazione unica. La transazione ricontrolla chiave nativa, casella, qualifica, scadenza e posizione, poi inserisce elementi/conflitti, ricevuta e audit insieme al cursore. I duplicati identici non creano risposte. Due letture dello stesso cursore hanno un solo vincitore. Errori di audit non avanzano il cursore; esito di commit incerto non viene ritentato automaticamente. La lettura successiva deve riacquisire la posizione corrente. Nessun messaggio viene cancellato o confermato al provider.

Il percorso MIME privato accetta byte RFC822 solo dal confine autenticato già qualificato. Il connettore deve fornire la dimensione integrale dichiarata dal server e un istante di ricezione stabile: né l'header Date né l'ora del fetch determinano la ricezione. Protocollo concreto, semantica della paginazione e recupero dopo cambio generazione restano da qualificare sul canale deliberato.

## MIME e allegati privati

La factory aggiuntiva usa postal-mime 4.0.7, fissato nel lockfile, per decodificare header, charset, quoted-printable e base64. Prima del decoder tollerante verifica la struttura MIME: separatori header/corpo, header strutturali singoli, chiusura di ogni multipart, encoding e limiti. Ammette multipart mixed/alternative/related; gli altri contenitori e gli encoding non supportati negano il lotto intero. Nessun troncamento, acquisizione parziale, retry o avanzamento del cursore su errore.

Limiti espliciti: 25 messaggi, 1 MiB di byte originali complessivi per pagina e per messaggio, 64 parti, profondità 12, 32 KiB di header per parte e 64 KiB complessivi, 32 allegati. Resta il tetto esistente di 2 MiB normalizzati per lotto. Un messaggio oltre i limiti richiede una successiva procedura deliberata; non viene saltato automaticamente.

Il payload immutabile conserva privatamente i byte originali in base64, dimensione e SHA256, più un manifesto degli allegati con ordine, nome originale, tipo dichiarato, disposizione, Content-ID, dimensione e SHA256 dei byte decodificati. I nomi non diventano percorsi sul filesystem e il tipo dichiarato non attesta sicurezza del contenuto. Gli allegati non vengono aperti, decompressi, eseguiti o promossi automaticamente a documenti CRM. I messaggi RFC822 allegati rimangono opachi e non possono fornire riferimenti o testo al messaggio esterno.

Solo il testo semplice può essere proiettato nel contesto ammesso; HTML e risorse esterne non vengono renderizzati o richiesti. Un messaggio solo HTML rimane conservato nell'area privata senza proiezione M4, come i messaggi non associabili. La proiezione usa campi espliciti e non trasferisce originale, manifesto o header privati in risposte, audit o eventi. Gli allegati rimangono esclusi dalla nuova bozza; la loro eventuale consultazione/importazione ammessa è un residuo distinto.

Le impronte comprendono l'intero originale: cambiare soltanto un allegato genera un conflitto, conserva la prima versione e nasconde anche una risposta precedentemente associata. Duplicati esatti restano idempotenti. Nessun valore JSON può sostituire la qualifica del canale o la ricevuta privata monouso.

La qualifica MIME aggiunge dieci casi unitari e quattro casi PostgreSQL (75 totali nella suite dedicata): originali privati e proiezione esplicita, conflitto del solo allegato, pagina non valida senza scritture e conservazione privata dei non associabili/HTML. Gli esiti valgono solo dopo l'esecuzione sul nuovo HEAD; i 71 casi del candidato precedente non ne costituiscono prova.

## Associazione e visibilità

L'acquisizione automatica non crea utenti, sessioni, concessioni o approvazioni. I nuovi item non compaiono nell'amministrazione M4, ricerca, contatori o esportazioni. L'associazione privata deriva il messaggio solo dal riferimento SMTP esatto, controlla ricevuta ACCEPTED della versione e destinatario pertinente della stessa casella, quindi applica i controlli nativi dell'utente corrente su pratica, progetto, documenti e vincoli finanziari. Nessun ID nel testo o indirizzo coincidente basta da solo.

Solo dopo tali verifiche viene creata la risposta M4; audit, link ed evento sono atomici. Lettura ordinaria senza nuovo step-up; né tale lettura né l'associazione consentono invii. Archivio, cestino, sessione revocata, documenti esclusi e perimetro selettivo continuano a negare. Un conflitto successivo nasconde la risposta già associata dalle nuove letture senza cancellarne l'originale. I lock dell'item serializzano conflitto e lettura.

La pagina comunicazioni offre «Collega risposte ricevute» sul messaggio con ricevuta ACCEPTED. L'action usa sessione/origine native, senza step-up, e rilegge versione e perimetro prima di individuare candidati. Solo riferimenti esatti e partecipanti della stessa casella arrivano al lotto di 25 elementi; nessuna inbox globale, conteggio di esclusi o chiamata al provider. Tutti i link e audit del lotto sono atomici. Il controllo di concorrenza resta sul messaggio e sugli item; risposta persa richiede rilettura, nessun retry automatico. Nessuna GET scrive collegamenti.

«Prepara risposta» apre una nuova bozza nel contesto ammesso, mostrando il testo ricevuto come testo non attendibile. Mittente, destinatari, testo e allegati restano da compilare esplicitamente; nessuna approvazione ereditata. Il salvataggio controlla di nuovo sorgente/hash, contesto, documenti, riservatezza, sessione e conflitti, mantiene il riferimento nell'evento M4 e verifica scadenza con clock DB dopo audit. La bozza segue poi anteprima e decisione personale proprie. Il collegamento è una fonte di lavoro: non afferma threading RFC dell'email uscente o inoltro automatico del messaggio ricevuto. Adattatore di ricezione operativo, consultazione/importazione ammessa degli allegati, rappresentazione ammessa dei messaggi solo HTML e riconciliazione dei non associabili restano residui.

## Qualificazione e recuperabilità

Unità: `node --import tsx --test tests/ordinary-email-inbound.test.ts` (nove casi), inclusa compatibilità dei riferimenti manuali M4 senza tabelle candidate. PostgreSQL: quindici casi aggiuntivi nella suite `tests/ordinary-email/store-db.test.ts`, inclusi CAS concorrente, audit/commit, revoche durante fetch, scadenza durante audit, duplicati/conflitti e associazione ammessa/negata. Le prove concorrenti osservano attese reali dei lock di chiave, canale e progetto prima della revoca. CI verifica DDL senza sentinel/base, rollback atomico del DDL e conteggio schema invariato. Gli esiti vanno attribuiti al singolo HEAD, non al precedente candidato di uscita.

Il seguito UI aggiunge sette casi PostgreSQL (71 totali): limite/pagine, GET senza scritture, riferimenti e accessi correnti, rollback del lotto, risposta persa, bozza senza eredità, conflitto/revoca/expiry e lock. Il nuovo `native-inbound.spec.ts` verifica login nativo, lettore diverso dall'autorità senza step-up, doppio clic, origine/replay, dati privati esclusi, markup non eseguito, selezione revocata, bozza esplicita e rifiuto personale, conflitto con form aperto e sessione/archivio. La sorgente di ricezione e lo storico ACCEPTED di questo scenario usano adattatori simulati; il TLS reale sintetico resta nel distinto scenario invio. Le tre prove browser non qualificano un provider di ricezione reale.

Prima di integrazione: riconciliare base PR191, metadati effettivi di ricezione e autenticazione già deliberati, autorità email/qualifica reale e piano SQL/versione/target/recuperabilità. Non usare il DDL di test in produzione. Un ritorno a codice che ignora cursori, conflitti o tentativi incerti non è un rollback sicuro; recuperare con codice compatibile e senza replay automatico.
