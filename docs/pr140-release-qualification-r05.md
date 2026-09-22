# PR140 — qualificazione del rilascio R05

PR140 è integrata: merge `d3cf4ea7309fc4fef7ed6bbf8db88924e974c6b4`, tree `d9696481ecc20c1495358682ba1af70b3f577d19`, [CI postmerge 13/13](https://github.com/Finanzaagevolaimpresa/CRM/actions/runs/35692673324). La qualificazione R04 e i tre backlog 4063069117, 4064631328, 4064631338 restano conservati. Questo delta non riapre quel PASS e non corregge quei backlog.

## Percorso interno distinto dal banco sintetico

Il candidato R05 introduce soltanto l'ammissione esplicita del flusso manuale esistente:

| Configurazione proposta, da autorizzare separatamente | Valore |
|---|---|
| INTERNAL_SESSION_MODE | registry |
| INTERNAL_ENGAGEMENT_MODE | controlled |
| CONTROLLED_INTAKE_MODE | internal |
| PRACTICE_READINESS_MODE | internal |

I tre nuovi esempi restano `disabled`; le impostazioni reali non sono modificate. Valori sconosciuti, mancanti, non canonici o sessioni legacy non ammettono il percorso interno. La modalità `synthetic` conserva integralmente i controlli di database effimero, sentinel, ambiente e loopback. Non si usa synthetic in produzione.

La modalità interna esegue le stesse transazioni, lock di sessione, verifiche correnti di ruolo/permessi e ambito cliente/progetto/materiale, revisioni e controlli di concorrenza. Il consenso a questa configurazione non è contenuto nel merge PR140 o in questo delta.

Direzione/amministratore con sessione registry corrente e permessi service.read/service.write prepara esplicitamente il catalogo dalla pagina Catalogo servizi. La funzione conserva e valida V1, crea le sole revisioni V2 attese e registra l'attore effettivo; conflitti fermano l'operazione, la ripetizione è idempotente. Il comando sintetico preesistente conserva il suo guard. Nessuna pubblicazione automatica all'avvio.

Percorso operatore: login interno, catalogo disponibile, acquisizione manuale, conversione del lead in cliente tramite l'azione autorizzata, cliente/progetto/preanalisi, preventivo e pratica, verifiche di disponibilità/materiali/incarico, avvio esplicito, dossier versionato, approvazione da altro attore ed eventuale consegna manuale. Pagamenti, firme e invii esterni non sono automatizzati.

## Sessioni e transizione da legacy

Applicare il contratto N02 già presente in [n02-internal-session-registry.md](n02-internal-session-registry.md): baseline di sessioni vive, finestra esplicita, rotazione proprietaria di AUTH_SECRET e attivazione registry soltanto con zero sessioni registry vive. La nuova app continua a rifiutare cookie legacy. Chiavi/secrets restano esclusivamente al proprietario; gli agenti ricevono soltanto ricevute minimizzate.

L'hook di avvio richiede zero sessioni vive anche al riavvio e nel rientro. Non viene rimosso o aggirato. Se sono presenti, l'avvio si ferma: servono scadenza verificata oppure revoca globale espressamente autorizzata. Il piano di rilascio deve comprendere questa eventualità e il conseguente nuovo login degli operatori. La revoca conserva le righe di sessione e tutti i riferimenti storici.

## Prova su immagini effettive

Il workflow `pr140-release-qualification.yml` costruisce due immagini usando solo sorgenti Git versionati:

- candidato: HEAD/tree esatti della PR R05;
- recupero: merge PR140 d3cf4ea7/tree d9696481, che contiene già tutti i guard R04.

Questo è un recupero concreto dal delta R05 alla versione PR140 verificata, mantenendo schema47 e dossier. Non è PR139 su database47, non è c89b8067, non è una futura build ipotetica. L'immagine PR140 non ammette nuove pratiche reali: durante il rientro il loro ingresso resta disattivato; la lettura e i controlli sui dossier versionati rimangono disponibili.

Il banco usa rete Docker interna, database `fai_crm_test` con sentinel e soli utenti/dati sintetici. Il server candidato gira con NODE_ENV=production, APP_ENV=production, registry e modalità internal, senza i flag di abilitazione del database sintetico. I processi che preparano e verificano fixture rimangono separati e vincolati al sentinel.

Sequenza qualificata soltanto quando la CI la conclude:
1. Immagini con revision/tree OCI verificati; schema47 applicato e immutato.
2. Login reale browser, catalogo preparato dall'attore autorizzato, acquisizione manuale e conversione.
3. Negativi per default-off, legacy, ruolo alterato, permesso revocato e sessione revocata; preparazione catalogo idempotente.
4. Tre percorsi pratica/dossier già acquisiti e regressioni R04 eseguiti contro l'app impacchettata in modalità interna.
5. Conteggi e SHA256 di dossier, versioni, review, export, autorizzazioni, ricevute, pratiche, materiali e ledger.
6. Guasto del candidato e rifiuto del primo riavvio di recupero per sessioni ancora vive.
7. Revoca esplicita nel solo banco sintetico, avvio dell'immagine PR140, nuovo login e verifiche positive/negative di dettaglio, ricerca, report, export negato e mutazioni legacy respinte.
8. Impronta invariata, documento sintetico persistente invariato, identità/avvio PostgreSQL invariati. Ripresa del candidato dopo lo stesso gate delle sessioni.
9. Conservazione dell'archivio delle due immagini, SHA256 dell'archivio, image ID, revision/tree e ricevute minimizzate nell'artefatto CI. Nessun registro esterno attivato.

L'archivio CI scade dopo14 giorni: prima di eseguire un rilascio occorre conservarlo nel percorso proprietario approvato e verificarne hash/digest, senza ricostruire immagini non nuovamente qualificate. L'esito del workflow è evidenza soltanto per l'HEAD effettivamente indicato nella ricevuta.

## Target, backup e piano operativo

Il [preflight proprietario](pr140-owner-preflight-r05.md) è l'unico intervento iniziale richiesto mentre prosegue la preparazione indipendente. Il contesto Desktop verificato opera come PC\\CodexSandboxOffline; non ripetere tentativi identici di accesso né cambiare policy/ACL/configurazioni. Le ricevute PR139 del20 settembre sono storiche e non attestano il target attuale.

Ultima baseline riferita: PR139/schema46, checkout `/home/faiadmin/.local/share/fai-crm-releases/release-3230764a4406-20260920`; `/opt/fai-crm` resta storico. Serve una ricevuta attuale prima di fissare immagini, risorse e finestra. Il backup schema43 disponibile non è un backup46 pertinente.

Il backup46 produttivo va preparato con il contratto N05 esistente, target e risorse della ricevuta corrente, set nuovo senza sovrascritture, quiescenza applicativa autorizzata, dump/documenti/configurazione coperti, manifest/checksum e recupero isolato verificato. Nessun contenuto protetto o chiave deve entrare negli artefatti dell'agente. Il relativo arresto app, le scritture di backup e l'eventuale recupero non sono eseguiti da questa qualificazione.

Unica migrazione produttiva prevista: `20260920090000_engagement_dossier_approval_delivery_v1`, SHA256 `f2f5927399f0f580654714015ebb975aacd47b741eda896b59e6cf475cfd6b88`. Nessuna migrazione aggiunta o modificata da R05. Prova46→47 precedente riutilizzata e mantenuta in CI sul suo vero riferimento schema46.

PIANO_RILASCIO_PR140_SCHEMA47_R01.md della task deve acquisire ricevuta corrente, digest qualificati, backup46 recuperabile, finestra, sessioni e rientro prima del giudizio operativo. Nessun deploy, migrazione, revoca di sessioni reali, modifica di configurazione, provider/worker/scheduler o attivazione reale viene eseguito da R05. Le autorizzazioni di merge del nuovo delta e di ogni passo produttivo restano distinte.
