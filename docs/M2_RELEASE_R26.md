# M2 — rilascio assistito sullo schema48 corrente

Delta operativo per passare da M1 `fb645e014653ee87dc64f2439970967192f91b62` a M2 `7ab126f8a2ef385c3e720f190eda80f26f61ae39` (tree `c4566387ec58e7eb7c82e3da52ef1424eb08e756`). Nessuna migrazione nuova: il programma confronta tutti i 48 checksum e non invoca Prisma migrate in produzione. L'immagine applicativa rimane quella già qualificata nella PR159, non viene ricostruita dal commit operativo.

Stato alla preparazione: software M2 CI verde, riesame finale ancora da acquisire; pacchetto operativo da qualificare separatamente. Nessun avvio produttivo è attestato da questo documento. Il builder esige review esatta del delta, CI sul medesimo HEAD, PASS e merge del software prima di produrre il launcher.

## Identità e ambiente

- Normale PowerShell Windows del proprietario, account/SID e programmi vincolati nel pacchetto; l'identità sandbox viene rifiutata.
- Profilo SSH proprietario ordinario, alias `fai-crm-prod`, espansione esatta `faiadmin@desk.finanzaagevolaimpresa.it:22`, host key rigorosa. VPS `fai-crm-prod-02`, UID/GID1000, engine/container/volumi/rete vincolati. Nessuna nuova chiave, delega, ACL o servizio persistente.
- Docker29.6.1/containerd, manifest OCI e config digest distinti; archivio SHA `3e0dd8b4ff7cd0d82fde2f7445334e1f764bd11042154f70905a171747cd7dc2`. Artifact GitHub10917328245/run36276199090, ZIP543122869byte/SHA `b20440ece95afd14b9421ecebeac6f58ee766e8b49083b91d2cf2a67eb496f23`.
- Recipient pubblico già approvato e destinazioni fisiche C:/F: conservati dal binding M1. I dischi vengono riconfermati a ogni copia, senza sostituire lettere o supporti.
- Configurazione M1 copiata solo sul VPS in file privato e verificata byte per byte; step-up v1 già ACTIVE deve corrispondere. Nessuna registrazione/rotazione di credenziali.

La lettura mirata dell'archivio nel run36278940196 ha dimostrato che gli ID97c04ee/8a31a996 della CI software sono digest di configurazione del daemon classic. I manifest OCI01c7a81/42ec4e54 nello stesso archivio puntano esattamente a quei digest: sono gli identificativi richiesti da Docker/containerd. Il programma verifica hash dell'archivio, entrambi i link manifest→config, piattaforma, layer e label; non sostituisce immagini o indebolisce un controllo. I due STOP precedenti riguardavano questa distinzione, prima di qualsiasi avvio produttivo. La successiva CI deve attestare anche il caricamento sul daemon qualificato.

## Sequenza del singolo avvio

Il futuro `AVVIA-M2.ps1`, con hash pubblicato alla costruzione qualificata, esegue:

1. Verifica account, programmi, pacchetto e identità fisiche C/F.
2. Acquisizione del solo artifact esatto, intervalli di8MiB e avanzamento, massimo600s; massimo due errori identici per blocco. Hash ZIP, ricevuta interna e hash TAR obbligatori; nessuna ricostruzione immagine.
3. Trasferimento esclusivo del nuovo pacchetto e dell'archivio verificato, massimo600s; nessun riuso di intent o tentativi storici.
4. Riconciliazione dell'app M1, schema48, risorse, modalità e chiave esistente; caricamento delle sole immagini qualificate e checkout locale del bundle immutabile. Nessun avvio applicativo in questa fase.
5. Backup corrente48, preservazione privata della configurazione, cifratura N05 e copie C/F con dimensioni, hash e readback. Questo set copre anche il residuo post-M1 ancora mancante, senza duplicarlo.
6. Recupero del nuovo dump e documenti in container temporanei senza rete, porte o volumi persistenti, con tmpfs, limiti, ledger/hash e cleanup verificati. Nessuna sovrascrittura del database produttivo.
7. Conferma ledger invariato; forward N05 della sola app e rientro applicativo qualificato se ammesso dalle ricevute canoniche. Migrazioni applicate: lista vuota.
8. Postcheck identità M2/schema48, salute app/PostgreSQL/HTTPS, risorse/configurazione immutate, PostgreSQL non riavviato.
9. Nuovo backup post-M2 con run distinto; cifratura e altre due copie C/F verificate.
10. Controllo finale e `ESITO-M2.json`. La prova d'uso M2 resta distinta, dopo login fresco.

## Sessioni, arresti e ripresa

Il guard M1 `assertRegistryActivationReady()` nega ogni nuovo avvio quando esistono sessioni vive. Il delta non modifica quel guard. Prima della quiescenza verifica la transazione di revoca con una query senza righe e rollback; dopo lo stop revoca le sole sessioni vive con motivo `INTERNAL_GLOBAL` e audit per utente, sotto l'unico amministratore attivo. Mantiene righe, digest, account e credenziali. La revoca avviene nella stessa transazione dell'audit; un errore non produce revoche parziali.

Durante il deploy la revoca avviene al confine `start` del controller N05, quando il vecchio writer è stato rimosso e il nuovo container è ancora fermo. Sono ricontrollati app esatta, immagini ammesse, risorse, ledger e assenza di consumatori estranei. Lock, supervisore, tempi e ricevute N05 restano quelli qualificati. Una sessione creata tra il backup e il deploy viene così revocata prima dell'avvio; il proprietario dovrà accedere nuovamente al CRM.

Un errore interrompe la sequenza e produce diagnostica minimizzata: fase/comando, exit code e classe/hash dell'errore, mai log grezzi o segreti. Un intent senza ricevuta non autorizza un nuovo tentativo. Il secondo avvio del launcher effettua soltanto la riconciliazione read-only. La ripresa richiede analisi delle ricevute e un pacchetto circoscritto, non il rilancio del set consumato.

Limite operativo esplicito: se il database non consente la revoca dopo la quiescenza, il programma non avvia consapevolmente un'app incompatibile con le sessioni residue e non ripete la transazione alla cieca. Il rientro non è dichiarato riuscito senza salute osservata; la condizione richiede riconciliazione. La diagnostica distingue questo caso dall'esito del backup. Non viene promesso un ripristino automatico per guasti del database/daemon o ricevute incerte.

## Qualificazione del delta e limiti delle prove

I test offline verificano generazione da byte storici sigillati, input estranei rifiutati, ordine quiescenza→revoca→dump, errore SQL senza ripetizione/avvio, ricezione esclusiva e assenza di provisioning/migrazioni nel controller riusato. CI Windows e Linux importano tutti i programmi generati. CI Docker29.6.1/containerd usa le immagini archiviate esatte e PostgreSQL reale: guard sessioni vive, preflight senza mutazioni, rollback atomico quando l'audit fallisce, revoca/audit, identità delle righe preservate e recupero isolato del nuovo set schema48.

La recuperabilità continua a provare dump/documenti in chiaro sul medesimo VPS. Non equivale a una nuova decifratura C/F, recupero della configurazione privata, ripristino completo dell'app o perdita totale del VPS. Prove C/F e tentativi storici rimangono intatti. Il rilascio assistito non qualifica l'autonomia mutativa di Codex.


## R29 — STOP prima della quiescenza e ripresa circoscritta

Il run R28 `8e0e7fecd0434cc18ea8d04057aefac8` ha completato acquisizione, trasferimento e preparazione; il backup si è fermato prima della quiescenza. La diagnostica identifica `BACKUP_RESOURCE_PREFLIGHT`, fase `BEFORE_QUIESCENCE`, exit1, stderr47byte/SHA256 `31a75e9ac33507086b8e92198b79fdb6391c8dea309a13bdc9e08fb3a466bd72`: corrispondenza esatta col messaggio pubblico `PRODUCTION_IMAGE_NOT_IMMUTABLE`. Il generatore usa il tag R05 vincolato al commit, mentre due guard della libreria N05 sigillata ammettevano soltanto i tag storici `prNNN`. L'app M1 risulta healthy nella riconciliazione successiva; il flag storico `appResumedHealthy=false` indica che il percorso di ripresa non è stato eseguito, non un'app fermata. Nessun set riuscito o rilascio M2 viene dedotto.

La correzione modifica soltanto la nuova copia privata della libreria: i due guard richiedono il tag esatto derivato dalla fonte sigillata del ruolo prima/dopo, conservando digest, label, risorse, consenso e quiescenza. Non allarga il formato generale né modifica i programmi storici o il runtime esistente. La diagnostica espone soltanto il codice pubblico esatto aggiuntivo.

Il nuovo pacchetto è una prosecuzione vincolata a quel solo STOP: verifica hash del vecchio manifest, prepare e STOP, quiescenza mai tentata, comandi terminati e assenza di fasi successive. Sul server confronta anche la STOP interna e rifiuta qualsiasi set, revoca o progresso del backup. Il nuovo prepare osserva ancora app/DB/ledger/chiave correnti prima delle fasi operative. Nessun intent precedente viene cancellato o riutilizzato.

Le immagini già verificate vengono copiate con hash/dimensioni/readback da quel percorso fisso sul PC e sul VPS. Non vengono scaricate, ritrasferite o ricaricate nel daemon; viene verificata la loro identità attuale. Si trasferiscono solo i programmi corretti e il bundle sorgente. Nuovi identificativi restano obbligatori per pacchetto, backup prima e backup dopo.

La regressione esegue realmente Bash su entrambe le varianti generate: riproduce byte/hash dell'errore, accetta solo il tag vincolato e rifiuta tag diversi. I test di riconciliazione rifiutano STOP successivi alla quiescenza, esiti incerti, ricevute cambiate, fasi avanzate e archivi alterati; non sovrascrivono una copia presente. La CI Docker esercita anche `resource_preflight()` e l'ambiente del programma backup generato, con immagini salvate, PostgreSQL/schema48, backup N05 completo e verifica del manifest. È un test sintetico del nuovo delta, non una nuova prova C/F o una ripetizione del tentativo produttivo.

Il nuovo avvio resta subordinato al PASS del solo delta R29 e alle sue CI. Il candidato applicativo M2/PASS e i merge PR159/160 sono conservati. Restano identici limiti di recuperabilità e arresto/riconciliazione, nessuna nuova migrazione o credenziale.
