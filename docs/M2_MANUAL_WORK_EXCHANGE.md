# M2 — pratica e lavorazione manuale con Work

## Delta

Il percorso esistente collega offerta accettata e versionata, formalizzazione,
evidenze di pagamento, servizio, materiali, avvio esplicito, preanalisi e dossier.
M2 aggiunge il passaggio manuale verso Work e il rientro nel medesimo dossier.
Il collegamento «Preanalisi → dossier e consegna» riapre il dossier già presente
solo dopo il controllo canonico di accesso; non propone di crearne un duplicato.

Il pacchetto ZIP contiene il manifest, il contenuto della versione corrente e i
byte delle versioni documentali VALIDATED del suo snapshot. Il manifest identifica
beneficiario, progetto, servizio/revisione, ambito dell'incarico accettato,
formalizzazione, responsabile del servizio, scadenza, materiali, autore e istante.
Ogni documento è verificato sul checksum della versione prima del download.
Le dimensioni sono limitate a 25 MB per file e 50 MB complessivi. Nessun percorso
di storage privato compare nel pacchetto o nei messaggi di errore.

Il comando è un POST dallo stesso origin configurato, con conferma della
lavorazione manuale autorizzata. Richiede i permessi correnti dossier.read,
dossier.write, service.read e document.download, oltre all'accesso canonico a
cliente/progetto/servizio e a ogni materiale, compresi quelli sensibili.
Un file mancante o alterato interrompe l'export senza registrare una ricevuta
di successo. Il medesimo identificativo di richiesta restituisce lo stesso
pacchetto, dopo aver rivalidato diritti e byte.

Il rientro richiede pacchetto e hash esatti, versione di partenza, riferimento
Work, produttore dichiarato e data con fuso orario. Registra una nuova versione
e la provenienza nella stessa transazione, azzera l'approvazione e torna in bozza.
Il riferimento e il produttore sono dichiarazioni manuali: non attestano che una
chat, un plugin o un'API abbia realmente eseguito il lavoro. Non si effettua alcun
caricamento automatico verso Work, invio email o chiamata AI.

Il replay identico non crea versioni o audit duplicati. Un risultato differente
contro una base già superata è respinto: occorre esportare la versione corrente.
Anche i replay rivalidano sessione, revoca, permessi e ambito documentale.
La revisione umana, l'export approvato, l'autorizzazione alla consegna e la ricevuta
manuale rimangono operazioni separate. L'autore non approva il proprio risultato.

## Persistenza e compatibilità

Nessuna migrazione: schema48 e le migrazioni storiche rimangono byte-identici.
Le versioni usano EngagementDossierVersion. Le ricevute tipizzate dei pacchetti
e dei rientri usano AuditLog con entityType=ClientDossier ed eventi
engagement_work_package_export / engagement_work_result_import, secondo la
convenzione di ricevute di dominio già usata dall'handoff M1. L'ID del pacchetto
è la chiave primaria della ricevuta; la transazione Serializable blocca il
dossier prima di registrare l'export o creare la versione importata.
Lettura e replay verificano struttura, hash e legami tra ricevute e versioni.

EngagementDossierExport e il suo vincolo SQL markdown/docx restano riservati
agli elaborati approvati: un pacchetto di lavoro non è un export approvato.
Il rientro all'immagine M1 conserva dati e nuove versioni; la UI Work resta
disponibile solo sull'immagine M2. La qualifica controlla l'impronta delle ricevute
attraverso il rientro applicativo e la loro lettura dopo il ritorno al candidato.
Questa verifica non equivale a un ripristino del database o a un rilascio reale.

## Prove richieste

- Unità: archivio riproducibile, byte/CRC/hash, rifiuto di file mancanti,
  alterazioni, nomi duplicati e percorsi di attraversamento; data non ambigua.
- Database isolato: roundtrip, invalidazione dell'approvazione, audit atomico,
  replay, base superata, ambito estraneo, revoca, permesso download negato,
  ricevuta alterata, approvazione distinta e consegna sintetica.
- Browser isolato: pratica già avviata da incarico/pagamento/materiali,
  apertura senza duplicazione, ZIP, rientro e riapertura, dinieghi di ambito e
  origin, approvazione indipendente e ricevuta simulata.
- Immagini: dati/receipt invariati durante rientro e ripresa, provenienza M2
  nuovamente visibile sul candidato. Nessun invio reale nei test.

Le esecuzioni effettive e le identità di candidato/CI/rilascio sono registrate
nel checkpoint di consegna. Questo documento descrive il delta e non dichiara
che i controlli o il deploy siano già riusciti.

## Residui preservati

Il backlog PR140 resta esplicito: nuovo tentativo dopo FAILED per medesima
versione/destinatari e completezza delle superfici con take12/take10. Non sono
necessari al roundtrip M2 e non vengono aggirati cambiando destinatari o
presentando gli elenchi limitati come completi. Una modifica al formato delle
autorizzazioni di consegna richiederà anche la corrispondente qualifica di
lettura nell'immagine di rientro. Il collegamento al dossier esistente è chiuso
da questo delta. I messaggi esterni approvati e i relativi tentativi appartengono
al successivo percorso M4.

Prima del rilascio serve il backup della produzione corrente schema48, copie
cifrate sulle destinazioni fisiche riconfermate e recuperabilità pertinente.
Il backup46 storico non copre i dati nuovi; l'autonomia del canale operativo
rimane un'attestazione separata. L'autorizzazione M2–M5 non modifica questi guard.
