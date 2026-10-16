# Email ordinario — candidato separato R01

Mandato COORD-DUE-PIANI-CRM-20261016-R01. Questo candidato prepara il nucleo verificabile dell'invio ordinario; non abilita un canale e non chiude il flusso completo. È separato da PR191, lifecycle progetti.

## Capacità esistenti e delta

M4 conserva bozze/versioni, approvazioni esatte, allegati con hash, tentativi, risposte e audit. Produce un pacchetto per invio esterno manuale. La qualificazione M4 `MANUAL_EXTERNAL` non qualifica SMTP o ricezione automatica. L'approvazione M4 ammette un Admin generico: non va riusata come autorizzazione personale di Antonio per un nuovo invio SMTP.

Il canale diagnostico usa la casella già deliberata `comunicazioni@finanzaagevolaimpresa.it`, TLS465 con verifica certificato, un destinatario protetto e testo fisso. Il controllo produttivo in sola lettura del 16/10/2026 ha verificato la presenza della configurazione e di una prenotazione/un risultato; non attesta un invio ordinario né la consegna. Non si aggiungono provider o credenziali.

R09 ha riconciliato il riferimento storico R35/R36/R40: provider `register_it`, configurazione `M4_COMUNICAZIONI_REGISTER_IT`. La verifica del solo metadato il 16/10 alle 11:23 UTC conferma casella, provider e configurazione, revisione corrente 2, responsabile assegnato e sette caselle abilitate/qualificate. Nessuna credenziale è stata letta; nessuna casella riconfigurata o prova d'invio ripetuta. Il candidato include questi riferimenti non segreti nell'intento esatto e rifiuta un altro provider, configurazione, indirizzo o una qualifica dichiarata manuale/diagnostica. Questo controllo del contratto non certifica da solo un canale ordinario: il futuro servizio dovrà leggere e verificare la qualifica persistita corrente nella transazione.

Il codice di questo candidato:

- riusa la validazione e lo snapshot immutabile M4 come contenuto di partenza;
- prepara MIME effettivo con oggetto Unicode, testo, TO/CC/BCC e versioni esatte degli allegati; BCC resta nel riepilogo e nella busta SMTP, senza comparire nelle intestazioni consegnate;
- produce un intento distinto `FAI_PERSONAL_ORDINARY_SMTP_V1`, che include hash della bozza, canale/revisione, riferimento univoco e data. Una vecchia approvazione manuale non è questo intento;
- distingue prenotazione, accettazione SMTP, mancato invio certo ed esito incerto. Non consente retry automatici;
- propone un'associazione in ingresso solo con casella canonica, riferimento esatto, mittente fra i destinatari, invio accettato e contesto ancora accessibile. Identità duplicata identica è un no-op; contenuto differente sulla stessa identità è un conflitto. Ambiguità in quarantena.

Queste funzioni non conferiscono autorità e non sostituiscono controlli transazionali: non sono collegate a route, pulsanti, socket, worker o scheduler. Le prove usano esclusivamente dati sintetici e confrontano i byte MIME effettivi.

## Decisione personale distinta

`ordinary-email-decision.ts` aggiunge il contratto verificabile di anteprima e conferma ordinaria. Richiede un riferimento esplicito `ordinary-email` / `ORDINARY_EMAIL` alla persona e alla casella: un binding `project-sharing`, un altro Admin o un account commerciale sono respinti. Il modulo non legge o scrive un binding reale e non assume che tale autorità sia già attivata.

L'anteprima firmata dura al massimo cinque minuti, comunque non oltre le scadenze della sessione dichiarata e del registro. Contiene soltanto identificativi, revisioni e hash: testo, indirizzi, credenziali e cookie restano fuori dal token. La conferma verifica lo step-up nativo, vincolato a persona, cookie, chiave e tempo; ricalcola intento e MIME con le versioni documentali esatte. Qualsiasi modifica a mittente, destinatari, testo, allegati, canale, contesto autorizzato, autorità o sessione invalida l'anteprima.

Il risultato è una decisione firmata da persistere, con `decisionId` stabile per quella anteprima. Una seconda conferma della stessa anteprima conserva lo stesso ID: la futura prenotazione dovrà consumarlo con un vincolo univoco atomico. Questo contratto non consuma un record e non impedisce da solo un replay; nessuna decisione restituita autorizza direttamente un socket. Stato corrente, orologio e contesto devono provenire dal server e dai lock della transazione, mai da campi del modulo. Il piano della persistenza è in [ORDINARY_EMAIL_PERSISTENCE_PLAN_R01.md](ORDINARY_EMAIL_PERSISTENCE_PLAN_R01.md).

Prove locali: sei casi del nucleo MIME/associazione e sei casi della decisione personale, con controlli avversi su identità, step-up, alterazione dei contenuti, scadenza, contesto e contraffazione. Si tratta di qualificazione sintetica del contratto, distinta dai futuri test DB/browser e da qualunque collaudo produttivo.

L'adattatore isolato `ordinary-email-smtp-candidate.ts` aggiunge undici prove di protocollo con socket e consumo in memoria sintetici. Richiede callback server obbligatori per consumo del tentativo committato, controllo corrente e risoluzione del trasporto qualificato; non fornisce un connettore predefinito. Hash esatti e BCC, rifiuto parziale dei destinatari, timeout/scrittura parziale e assenza di retry sono descritti in [ORDINARY_EMAIL_SMTP_CANDIDATE_R01.md](ORDINARY_EMAIL_SMTP_CANDIDATE_R01.md). Non è ancora un collegamento alla persistenza o al provider reale.

## Flusso successivo concreto

1. Adattatore ricezione autenticato per la casella esistente: acquisizione continua senza consenso per ogni messaggio, identificativo provider stabile e deduplica atomica. Ricezione da verificare: nessun adattatore IMAP/API e nessun endpoint/abilitazione risultano qualificati in questo candidato. Non inventare un host dal nome del provider.
2. Associazione proposta sui soli metadati autorizzati. Un indirizzo cliente uguale o un ID citato nel corpo non bastano. Ambiguo/nuovo contatto resta in coda da associare, senza propagazione di diritti.
3. Bozza versionata riusando contesto, allegati e ABAC M4; pulsanti brevi «Modifica», «Rifiuta», «Approva e invia». Antonio vede mittente, Reply-To, TO/CC/BCC, testo e allegati/versioni prima di decidere.
4. Sessione autorevole e step-up esistenti; risoluzione del solo account personale canonico. Il collegamento `project-sharing` identifica oggi l'autorità della condivisione: non è automaticamente un permesso SMTP. Il piano deve distinguere riconciliazione dell'identità e nuova autorizzazione del canale.
5. Transazione di prenotazione con intento esatto, revisione corrente di bozza/casella, versione della decisione personale, controllo del contesto e hash dei byte. Commit dell'audit/prenotazione prima di aprire il socket. Un errore di audit non può lasciare un invio autorizzato.
6. Trasporto del solo intento prenotato. Nessun retry della transazione intorno a un effetto esterno. Timeout/disconnessione dopo DATA o esito di commit ignoto → incerto e riconciliazione; nuovo requestId non sblocca un duplicato. Un mancato invio certo richiede una nuova decisione personale prima di un nuovo tentativo.
7. Esito persistito e ricevuta minimizzata. SMTP250 significa accettato dal server, non consegnato/letto. Ricevute provider devono essere autenticate e correlate; un'email esterna che dichiara «consegnato» non vale come prova.

La UI deve consentire lettura ordinaria delle comunicazioni nel perimetro senza nuove micro-approvazioni; decisioni di permesso e invii restano personali. Le modifiche a qualsiasi elemento approvato invalidano la decisione. Archivio/cestino, revoche e scadenze vanno verificati di nuovo nella transazione, anche da sessioni già aperte.

## Residui e gate

| Residuo | Responsabile | Prossimo evento |
| --- | --- | --- |
| Persistenza ordinaria e riserva atomica, concorrenza e audit nativo | Delivery CRM | Candidato DB sintetico; valutazione schema/SQL preciso prima di qualunque migrazione produttiva |
| Identità personale, step-up e UI | Delivery CRM | Collegamento transazionale al riferimento canonico, senza nuovi account/ruoli |
| Adattatore SMTP ordinario e qualifica del canale esistente | Delivery CRM | Contratto di trasporto e 11 test di protocollo sintetici implementati; restano callback persistenti, vero connettore e qualifica del canale. Nessun invio reale senza approvazione personale della versione esatta |
| Ricezione ufficiale sulla casella esistente | Delivery; R09 ha fornito casella/provider/configurationRef canonici | Restano da verificare endpoint/protocollo e autorizzazione operativa già esistenti; i riferimenti M4 non li provano. Nessuna nuova credenziale/provider |
| Prove complete ricevuto→bozza→decisione→invio→esito | Delivery CRM | PostgreSQL isolato e browser dopo i punti precedenti |

Stato: preparato e nucleo implementato/testato; non integrato nel CRM, non distribuito, non attivato e non collaudato in produzione. Nessuna nuova migration o variabile d'ambiente introdotta da questo candidato. La prima integrazione completa dipende dalla qualifica dei canali e della persistenza; non è stimabile come completamento certo oggi finché questi prerequisiti non sono verificati.

Prima di integrare questa PR occorre riconciliarne la base con l'esito definitivo di PR191 e qualificare anche archivio/cestino, revoche e scadenze. Il backbone N15 esistente conserva intenti `RECORDED/HELD` con controlli dormienti: non viene attivato o trasformato in dispatch SMTP. Le approvazioni M4 e l'autorità `project-sharing` non possono sostituire una decisione email personale distinta; nessun binding reale è scritto da questo candidato.
