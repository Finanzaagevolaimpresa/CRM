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

Il contratto attuale ammette solo il payload testuale normalizzato definito dal tipo; il futuro adattatore deve rifiutare formati, allegati o dimensioni non gestiti senza avanzare il cursore. Non può troncare o dichiarare acquisita una pagina incompleta. Protocollo concreto, semantica della paginazione, MIME/allegati e recupero dopo cambio generazione restano da qualificare sul canale deliberato.

## Associazione e visibilità

L'acquisizione automatica non crea utenti, sessioni, concessioni o approvazioni. I nuovi item non compaiono nell'amministrazione M4, ricerca, contatori o esportazioni. L'associazione privata deriva il messaggio solo dal riferimento SMTP esatto, controlla ricevuta ACCEPTED della versione e destinatario pertinente della stessa casella, quindi applica i controlli nativi dell'utente corrente su pratica, progetto, documenti e vincoli finanziari. Nessun ID nel testo o indirizzo coincidente basta da solo.

Solo dopo tali verifiche viene creata la risposta M4; audit, link ed evento sono atomici. Lettura ordinaria senza nuovo step-up; né tale lettura né l'associazione consentono invii. Archivio, cestino, sessione revocata, documenti esclusi e perimetro selettivo continuano a negare. Un conflitto successivo nasconde la risposta già associata dalle nuove letture senza cancellarne l'originale. I lock dell'item serializzano conflitto e lettura.

L'associazione è ancora una funzione privata; UI di ricezione/riconciliazione e collegamento a un adattatore operativo sono residui. Nessun invio, contatto provider o dato reale nelle prove.

## Qualificazione e recuperabilità

Unità: `node --import tsx --test tests/ordinary-email-inbound.test.ts` (nove casi), inclusa compatibilità dei riferimenti manuali M4 senza tabelle candidate. PostgreSQL: quindici casi aggiuntivi nella suite `tests/ordinary-email/store-db.test.ts`, inclusi CAS concorrente, audit/commit, revoche durante fetch, scadenza durante audit, duplicati/conflitti e associazione ammessa/negata. Le prove concorrenti osservano attese reali dei lock di chiave, canale e progetto prima della revoca. CI verifica DDL senza sentinel/base, rollback atomico del DDL e conteggio schema invariato. Gli esiti vanno attribuiti al singolo HEAD, non al precedente candidato di uscita.

Prima di integrazione: riconciliare base PR191, metadati effettivi di ricezione e autenticazione già deliberati, autorità email/qualifica reale e piano SQL/versione/target/recuperabilità. Non usare il DDL di test in produzione. Un ritorno a codice che ignora cursori, conflitti o tentativi incerti non è un rollback sicuro; recuperare con codice compatibile e senza replay automatico.
