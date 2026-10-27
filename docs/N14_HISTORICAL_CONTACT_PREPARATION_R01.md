# Contatto antecedente all’ingresso nel CRM — candidato

Questo ramo dipende da PR232 e completa l’intake di un cliente contattato prima della creazione del lead. La catena Prisma resta a schema69: le due DDL in `ops/n14-historical-*-schema.draft.sql` sono ammesse soltanto nel database sintetico con sentinel. Non sono migration produttive e il ramo non è distribuito.

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

Il precedente candidato `8715410e61abe06894412c8e6a34ca9f435f50b6` ha superato 42 prove PostgreSQL (run `40580424133`, job `122458006030`) e 4 prove browser native (run `40580424154`, job `122458006477`). Quelle prove qualificano la registrazione del contatto e la conversione transazionale allora presenti, senza la nuova pagina di conversione.

Il delta attuale aggiunge la pagina e le action di conversione, la firma del contenuto esatto, la riconciliazione nativa e l’indicazione SLA. Sono predisposte 48 prove PostgreSQL e 7 browser complessive: percorso positivo, contenuto cambiato, revoca, attore estraneo, concorrenza, audit atomico, chiave ritirata, risposta persa, ricaricamento e assenza di un secondo cliente. Devono passare sul nuovo commit; i risultati precedenti non si trasferiscono. Le prove usano soltanto dati sintetici e nessun provider.

Restano da completare: modello e migration produttivi, compatibilità con i percorsi esistenti, regressioni complete e build, ispezione delle schermate desktop/mobile, pacchetto e riesame indipendente, piano con SQL/hash/target/impatti/recuperabilità e autorità specifica per la produzione. Nessuna conversione, contatto, concessione o comunicazione reale è eseguita.
