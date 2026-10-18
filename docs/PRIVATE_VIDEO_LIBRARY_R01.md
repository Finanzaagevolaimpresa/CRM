# Libreria video privata — R01

L'Admin può caricare un video come bozza privata, scegliere titolo, descrizione, categoria, ordine, persone o aree esistenti, controllare il riepilogo nominativo e pubblicare. Il player si trova nell'area Video. La gestione è riservata agli Admin con permesso corrente e conferma amministrativa personale. Il solo ruolo Admin non rende pubblici i video: la visione ordinaria richiede l'inclusione tra i destinatari.

## Destinatari e decisione personale

Commerciali, Ufficio tecnico, Amministrazione, Direzione e Revisori riusano i gruppi esistenti. La selezione di un'area viene risolta in persone effettive alla conferma; i futuri membri non ricevono accesso automaticamente. Cambi rilevanti tra riepilogo e conferma invalidano la decisione.

Titolo, testo, file, destinatari, versione, sessione e permessi correnti sono vincolati al riepilogo. Pubblicazione, modifica, archiviazione e ripristino hanno ricevuta idempotente, controllo di versione, revisione immutabile e audit atomico. Dopo una risposta persa si verifica la ricevuta. Archiviare revoca la visione; ripristinare produce solo una bozza, anche se i vecchi destinatari o i byte non sono più disponibili. Una nuova pubblicazione richiede una nuova decisione.

L'anteprima come destinatario richiede la conferma personale dell'Admin e mostra il risultato dei diritti correnti; non impersona l'utente e non concede accesso. Download e riproduzione sono scelte distinte. La disabilitazione del comando download non costituisce DRM: il browser riceve necessariamente i byte per riprodurre il video.

## Letture e file

Sessione/registro, utente, autore della pubblicazione, generazioni, stato, scadenza e destinatari sono ricontrollati dal server per elenco, ricerca, metadati, URL diretto, GET, HEAD e ogni richiesta Range. Le letture non scrivono ricevute. Revoca, cambio ruolo o successiva riabilitazione non fanno rivivere una vecchia pubblicazione. Le scadenze sono verificate anche dopo lettura del file, prima della risposta.

MP4 e WebM, massimo 20 MiB per file e 1 GiB per l'intera libreria, comprese bozze, archivio e prenotazioni incomplete. Si riusa lo storage locale privato approvato, con percorso UUID e file non pubblici. Il controllo dell'intestazione identifica il contenitore; la compatibilità del codec dipende dal browser. I test nativi usano un WebM sintetico effettivamente riproducibile.

La quota è riservata con lock e transazione serializzabile prima della scrittura. I byte sono verificati per dimensione e SHA256 prima della disponibilità e a ogni lettura. Una scrittura incompleta mantiene la prenotazione e richiede riconciliazione; non si ripuliscono automaticamente file o storico. Lo stesso comando accetta soltanto gli stessi byte. Nessun provider, transcodifica o costo esterno aggiunto.

## Schema e qualificazione

La migration `20261018000000_private_video_library_v1` aggiunge VideoAsset, VideoEntry, VideoRevision e VideoCommand, otto relazioni restrittive, vincoli di quota e storico atomico. Richiede il prefisso esatto di schema53 integrato da PR195. Non crea video, pubblicazioni, destinatari o concessioni. Hash SQL/schema e baseline sono in `scripts/private-videos/schema-binding.json`; le 53 migration precedenti non cambiano.

Prove preparate: 29 contratti pure/storage/HTTP, 17 casi PostgreSQL, 9 percorsi browser nativi con schermate desktop/mobile, upgrade53→54 con errore atomico e conservazione di tutte le righe storiche, replay negato. Sei percorsi browser verificano la rimozione esplicita dei destinatari nominativi diventati inattivi, eliminati logicamente o privi di video.read, sia dal video pubblicato sia dalla bozza ripristinata: nessuna mutazione automatica, rifiuto server finché la selezione resta invalida, salvataggio in bozza, nuova anteprima/conferma e visione soltanto della persona appena ammessa. Le regressioni DB usano anche UUID numerici che il filtro privacy oscura nel testo libero: il collegamento atomico usa la chiave opaca dell'audit, senza modificare il filtro; i vincoli differiti vengono verificati nel callback prima del commit. La qualifica PR140 comprende file sintetici effettivi, pubblicazioni, archivio, bozza ripristinata, permessi revocati, prenotazione incompleta e storico dopo riavvio compatibile. I workflow legano ogni risultato all'HEAD/tree effettivamente eseguiti.

Stato alla preparazione R01: typecheck e lint locali superati; CI PostgreSQL/browser/build/recuperabilità ancora da eseguire. Il test generale locale su Windows ha 904 PASS, 27 FAIL e 142 SKIP: non è un PASS generale e richiede la qualificazione Linux. Le prove e i relativi risultati vengono riportati sulla PR esatta.

La distribuzione richiede PASS indipendente, CI dell'esatto candidato, immagine del merge qualificata, piano SQL54 con impatti e recupero compatibile e autorizzazione specifica. Non riusa l'approvazione SQL53; non ammette down-migrate, vecchio codice incompatibile, nuovi backup o restore DB presunti. Nessuna produzione modificata da questo incremento in preparazione.
