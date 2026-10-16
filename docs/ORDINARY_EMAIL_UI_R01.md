# Decisione personale email nella pagina nativa — R01

PR192 resta draft distinta da PR191. `/communications` integra anteprima, rifiuto, «Approva e invia» e ricevute tramite le azioni Next. L'invio usa il trasporto server descritto in [ORDINARY_EMAIL_TRANSPORT_R01.md](ORDINARY_EMAIL_TRANSPORT_R01.md). Nessun binding o canale produttivo viene creato: l'autorità email rimane distinta dalla condivisione progetti.

Il server mostra i controlli alla persona del binding email corrente, con chiave e cookie/sessione validi. Ogni azione ricarica contesto, documenti/byte, casella, autorità e orologio del database. Gli altri Admin possono consultare quanto loro ammesso, ma non decidere per la persona. L'assenza delle sei tabelle candidate mantiene utilizzabile schema50; schema parziale o errore SQL non simula una disponibilità positiva.

L'anteprima mostra Da, Reply-To, A/CC/BCC, oggetto, testo, allegati/versioni/hash e scadenza. Revisione e impronta impediscono di presentare una risposta concorrente come la versione della pagina. Modifiche locali, scadenza, pagina nascosta e ritorno dalla cache eliminano anteprima e conferme. Nessun token in storage o URL.

La disponibilità dell'invio viene calcolata dal server sul trasporto corrente sotto i lock dell'anteprima; è solo informativa. Una qualifica ordinaria mancante o diversa lascia disponibile il rifiuto ammesso e nasconde il comando di invio. La conferma ricontrolla sempre la qualifica effettiva in prenotazione/claim/DATA: manipolare la UI non concede accesso.

Invio e rifiuto richiedono intenzioni esplicite distinte e step-up nativo. Selezionare una conferma deseleziona l'altra. Il rifiuto conserva la versione e crea una nuova bozza non approvata con CAS/audit. L'invio vincola la versione esatta e un UUID di richiesta; il token viene scartato prima del POST, il blocco sincrono impedisce il doppio clic. Risposta persa o errore richiedono rilettura dello stato, senza retry. Accettazione SMTP, mancato invio certo, esito incerto e dichiarazione manuale restano distinti; una ricevuta SMTP non certifica consegna o lettura.

## Qualifica sintetica

Il job `Ordinary email PostgreSQL candidate` esegue 49 casi PostgreSQL e due scenari browser separati. L'esito qualificante è quello dell'HEAD corrente, non i PASS di commit precedenti.

`native-ui.spec.ts` conserva login/step-up effettivi, altro Admin/origine estranea, due sessioni/versione concorrente, invalidazione locale, risposta persa dopo rifiuto con replay, audit realmente conservato, revoca sessione e archivio. Il canale non è qualificato al trasporto: zero tentativi SMTP.

`native-send.spec.ts` usa l'action reale, il connettore Node e un server TLS sintetico. Verifica canale cambiato, sessione revocata, chiave ritirata, altro Admin con step-up, versione concorrente, doppio clic, commit con risposta persa e replay. Confronta hash dei byte MIME e destinatari osservati dal server con la decisione persistita, senza esporre BCC negli header. Include accettazione, rifiuto RCPT ed esito incerto dopo DATA, con ricevute distinte e nessun retry.

Il runner crea un solo network Docker interno per app/SMTP; il database sintetico fresco viene collegato a tale network. L'app ha una sola rete, nessuna route IPv4 predefinita e IPv6 disabilitato; il nome SMTP canonico risolve alla propria interfaccia sintetica. Nessun DNS/provider produttivo viene modificato. Certificato e CA sono effimeri e fuori dagli artefatti, la CA è riconosciuta dal solo processo di test. SNI e verifica del certificato restano attivi; due probe respingono nome errato e CA non fidata. Le credenziali sono sintetiche, mascherate e non registrate. Nessun flag di bypass applicativo.

Gli screenshot desktop/mobile sono generati in CI; generazione e assenza di overflow non equivalgono a ispezione visiva. Le prove JSON contengono soltanto riscontri minimizzati.

Restano ricezione autenticata/cursori, riferimenti operativi e qualifica reale del canale, binding email autorizzato e piano SQL produttivo con recuperabilità. Riconciliare la base con PR191 prima dell'integrazione. Nessuna attivazione o invio reale deriva dalle prove.
