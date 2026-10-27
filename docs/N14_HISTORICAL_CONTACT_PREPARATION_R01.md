# Contatto antecedente all’ingresso nel CRM — candidato

Questo ramo dipende da PR232 e completa l’intake di un cliente contattato prima della creazione del lead. La migration candidata `20261027220000_historical_lead_contact_v1` porta la catena Prisma da 69 a 70: aggiunge due registri inizialmente vuoti e conserva i record precedenti. Lo schema69 resta la baseline produttiva; il ramo non è distribuito e SQL70 richiede un piano riesaminato e un’autorità specifica. Le precedenti DDL in `ops/` restano soltanto riferimenti storici di preparazione sintetica.

## Percorso e autorità

L’Admin assegna il lead manuale tramite la Commercial Lead Inbox. Il commerciale corrente accetta personalmente la responsabilità e registra il contatto effettivo nella scheda del lead, con evento, fuso orario, fonte e riferimento espliciti. L’Admin non attesta per il commerciale. La fonte è una dichiarazione dell’operatore, non una prova automaticamente verificata né un URL da aprire.

Il contatto deve precedere l’ingresso nel CRM. Evento reale, inizializzazione dell’inbox e registrazione determinata dal database restano distinti. Il primo incremento riguarda il primo ciclo di un lead manuale aperto, non convertito, non nel cestino e senza prima risposta già registrata. Il percorso ordinario continua a richiedere una prima risposta effettiva nel proprio ciclo.

Dopo la ricevuta del contatto, il referente con permessi correnti di lettura e creazione cliente apre «Prepara la conversione in cliente». Sceglie il tipo e verifica un riepilogo del nome, delle note da conservare, del referente e della base storica. La conferma è una decisione separata. Contratto, pagamento, avvio del servizio e creazione della pratica non vengono simulati o creati automaticamente.

## Anteprima e persistenza

Ogni riepilogo firmato ha un dominio distinto e scade entro cinque minuti o alla scadenza della sessione. Vincola comando, attore, sessione, inbox, ciclo, versione, accettazione corrente, contatto e contenuto esatto del cliente da creare. Il server rilegge e blocca le righe autorevoli, controlla la chiave registrata, i permessi e la scadenza nella transazione di salvataggio. Un cambio di note, referente, accettazione, permessi o versione rende inutilizzabile il riepilogo precedente.

La registrazione conserva una ricevuta immutabile, avanzamento della versione e audit minimo atomici. La conversione usa lo stesso servizio N14, le stesse righe Lead/Inbox/Ciclo/Client e lo stesso storico: non introduce una seconda coda. La ricevuta collega comando, attore, sessione, contatto e cliente. I trigger differiti verificano il legame con l’audit della stessa transazione; il filtro privacy condiviso resta invariato.

Prima della richiesta di salvataggio, il browser conserva soltanto il comando nell’URL. Dopo una risposta persa o un esito incerto rende disponibile esclusivamente la verifica della decisione. Ricaricamento e lettura non scrivono. Le letture dell’esito ricontrollano titolarità, sessione, accettazione, permessi sul cliente e ricevute collegate. Una ricevuta assente non consente di ripetere il comando.

## SLA

La conversione storica conserva `firstResponseAt = null`, le date originali e la policy del ciclo. Usa l’esito distinto `HISTORICAL_CONTACT_BEFORE_CRM`, vincolato alla ricevuta della conversione. Non attribuisce un successo o un ritardo SLA a un evento avvenuto prima del CRM.

Scheda lead e inbox mostrano «Contatto precedente al CRM · SLA non misurato». I filtri delle risposte in scadenza considerano soltanto cicli aperti; i normali esiti MET/BREACHED restano legati alla risposta effettiva. La scadenza del contatto o dell’anteprima non è un invio programmato.

## Prove e limiti attuali

Il candidato `6cf295462ddae42582c0c388139aa3f42fb0bc38` ha superato 48 prove PostgreSQL (run `40582723602`, job `122466108232`) e 7 prove browser native (run `40582723504`, job `122466106694`), senza errori o prove saltate. Qualificano registrazione, riepiloghi, conversione, riconciliazione e dinieghi sulle DDL sintetiche precedenti; non sono prove della nuova migration né delle modifiche successive.

Il candidato SQL70 aggiunge il vincolo di immutabilità dell’audit storico e lo integra nella catena Prisma, nei controlli di attivazione email e nelle qualifiche dell’immagine. Sono predisposte 49 prove PostgreSQL e 7 browser sul nuovo commit. La qualifica SQL69→70 confronta tutte le righe precedenti, le prime risposte e gli SLA, verifica il fallimento atomico della migration e conserva i checksum storici. La qualifica PR140 ripopola contatto e conversione sintetici e ne verifica lettura, dinieghi e impronte prima e dopo il riavvio della stessa immagine. Nessuna di queste prove è dichiarata passata prima dell’esito CI sull’HEAD esatto.

La migration richiede esattamente 69 migrazioni completate e nessuna precedente in esito ambiguo. Non modifica dati precedenti, non crea contatti, clienti, incarichi o invii reali. Aggiorna il vincolo SLA mantenendo tutte le condizioni ordinarie: il nuovo esito storico richiede una ricevuta della stessa transazione. Il recupero usa esclusivamente codice compatibile con schema70; nessun down-migrate o ripristino DB è qualificato.

Restano regressioni complete e build, ispezione delle schermate desktop/mobile, pacchetto e riesame indipendente, piano con SQL/hash/target/impatti/recuperabilità e autorità specifica per la produzione. Nessuna conversione, contatto, concessione o comunicazione reale è eseguita.
