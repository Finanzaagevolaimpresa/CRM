# M2 — rilascio assistito sullo schema48 corrente

Delta operativo per passare da M1 `fb645e014653ee87dc64f2439970967192f91b62` a M2 `7ab126f8a2ef385c3e720f190eda80f26f61ae39` (tree `c4566387ec58e7eb7c82e3da52ef1424eb08e756`). Nessuna migrazione nuova: il programma confronta tutti i 48 checksum e non invoca Prisma migrate in produzione. L'immagine applicativa rimane quella già qualificata nella PR159, non viene ricostruita dal commit operativo.

Stato alla preparazione: software M2 CI verde, riesame finale ancora da acquisire; pacchetto operativo da qualificare separatamente. Nessun avvio produttivo è attestato da questo documento. Il builder esige review esatta del delta, CI sul medesimo HEAD, PASS e merge del software prima di produrre il launcher.

## Identità e ambiente

- Normale PowerShell Windows del proprietario, account/SID e programmi vincolati nel pacchetto; l'identità sandbox viene rifiutata.
- Profilo SSH proprietario ordinario, alias `fai-crm-prod`, espansione esatta `faiadmin@desk.finanzaagevolaimpresa.it:22`, host key rigorosa. VPS `fai-crm-prod-02`, UID/GID1000, engine/container/volumi/rete vincolati. Nessuna nuova chiave, delega, ACL o servizio persistente.
- Docker29.6.1/containerd, manifest OCI e config digest distinti; archivio SHA `3e0dd8b4ff7cd0d82fde2f7445334e1f764bd11042154f70905a171747cd7dc2`. Artifact GitHub10917328245/run36276199090, ZIP543122869byte/SHA `b20440ece95afd14b9421ecebeac6f58ee766e8b49083b91d2cf2a67eb496f23`.
- Recipient pubblico già approvato e destinazioni fisiche C:/F: conservati dal binding M1. I dischi vengono riconfermati a ogni copia, senza sostituire lettere o supporti.
- Configurazione M1 copiata solo sul VPS in file privato e verificata byte per byte; step-up v1 già ACTIVE deve corrispondere. Nessuna registrazione/rotazione di credenziali.

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
