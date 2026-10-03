# M4 — rilascio assistito da M3 verificato

Il candidato è `e00acfe008c9d2c0504a551198688296797c2491`, tree
`9da5856e9272bb72af9f173440300daf07d41cfc`, con la correzione delle sole letture M4
chiusa dal Revisore nella PR167. Le immagini salvate del run `36328704625`
includono il ritorno M1 qualificato su schema49. Non si distribuisce il codice M5.

La sorgente è M3 `9508d0da1b9642b02609d7431a984ced7b501e2e`, distribuito dal run
`a5c84e80bdd3473d83f542974fc8da06`. Le ricevute del 27 settembre alle 15:58 UTC
attestano salute tecnica, backup/copie prima e dopo, schema48 e recupero isolato.
Il nuovo preflight riconcilia tutte le identità correnti prima delle mutazioni;
non presume valida indefinitamente quella osservazione.

## Percorso finito

Un avvio PowerShell proprietario verifica account, programmi, alias/host key,
identità fisiche C/F, immagini e hash; crea un nuovo backup schema48 con revoca
auditata delle sessioni, copie cifrate C/F e recupero del set DB/documenti in
container isolati. Solo dopo questi gate avvia la singola migrazione
`20260927010000_approved_manual_communications_v1`, SHA256
`eaba8119ad0409ff4fa9a5de0f63109ffe7d6a721c69633b40c5193c3b0a2dc8`.

Il migratore usa l'immagine candidata esatta, nessun volume/porta, risorse
limitate, rete PostgreSQL esistente e credenziale privata al server. Il lock
N05, assenza di sessioni attive e integrità del prefisso sono riconfermati.
Il prefisso48 completo deve restare identico; dopo si ammette soltanto schema49.
Anche un errore o timeout comporta riconciliazione del preciso migratore prima
del rilascio del lock. Non si ripete una migrazione incerta e non si applicano
down migration. Il ledger49 già presente ferma questo pacchetto, destinato
esclusivamente alla transizione corrente 48→49.

Seguono deploy M4, salute HTTPS/registry/step-up, controllo delle sette caselle
registrate ma non configurate/abilitate, backup schema49 distinto, cifratura e
copie C/F, ricevuta finale. La configurazione privata è conservata byte per byte.
I nomi interni `backup48_after.py`, `observe48_after.py` e `protect48.py` restano
compatibili con gli helper riusati: sorgente, protocollo e schema effettivi sono
vincolati per ruolo e verificati dai test (48 prima, 49 dopo).

STOP conserva marker e ricevute: rilanciare lo stesso pacchetto offre soltanto
status. Nessun nuovo tentativo storico, cambio ACL, SSH, credenziale, guard,
servizio autonomo, provider, consumer, worker, scheduler o casella attivata.

## Qualificazione e limiti

Si riusano i byte operativi PR167 esatti, con adattamenti controllati e rifiuto
se cambiano i punti di trasformazione. Test Windows/Linux coprono i percorsi,
la sequenza, gli errori non ripetibili, le evidenze e il migratore. La CI usa
le immagini M3/M4 salvate: migrazione reale da48 a49, conservazione key registry
e prefisso, sette caselle disabilitate, backup generato49, cifratura age1.3.2 con
decifratura esclusivamente sintetica e recupero DB/documenti isolato.

Il recupero produttivo previsto riguarda il nuovo set in chiaro sullo stesso
VPS: non attesta nuova decifratura produttiva C/F, configurazione ripristinata,
applicazione ripristinata o perdita totale VPS. Il ritorno M1 preserva schema49
e le righe M4 ma rende le funzioni M2/M3/M4 indisponibili; le relative lavorazioni
vanno sospese. La prova d'uso richiede nuovo login e i dati/servizi effettivi:
non si inventano pratiche, approvazioni o invii per dichiarare una prova completa.

Le autorizzazioni di rilascio e migrazione M4 sono quelle del mandato vigente;
il pacchetto richiede PASS e CI sul proprio HEAD esatto prima dell'avvio.
La qualifica dell'autonomia resta distinta.

## Correzione R34 del controllo immagini

Il downloader generato confronta la ricevuta completa con la qualificazione M4
schema49 vincolata, correggendo il precedente confronto residuo con schema48.
La CI attraversa lo stesso metodo di estrazione usando lo ZIP GitHub originale,
prima di usare l'archivio per le prove Docker. I test rifiutano schema48 e campi
di qualificazione cambiati prima di creare l'archivio estratto.

Un pacchetto nuovo può ricevere una copia locale dello ZIP già scaricato:
dimensioni, SHA256 e ricevuta devono corrispondere prima del riuso. Uno ZIP
locale difforme ferma il percorso senza scaricare o sovrascrivere nulla. Il
pacchetto storico, il marker e la ricevuta STOP restano invariati; la ripresa
usa un nuovo run e riconcilia nuovamente M3 prima delle operazioni produttive.
# R35 — protection provenance and continuation of the completed backup

The M4 candidate is a distinct Git history from the actually deployed M3 read-fix
commit. The consumed R34 run completed and verified its schema48 backup, then
the protection adapter loaded N05 from the M4 runtime and tried to resolve the
M3 source tree in that repository. An isolated clone of the exact candidate
bundle reproduces Git exit 128. A full development checkout had masked this
missing-object dependency in the earlier qualification.

`protection_kit(role)` now selects the M3 runtime for the before backup and the
M4 runtime for the after backup. Both selections require exact commit/tree and
the canonical program hash. Canonical N05 bytes and its source, component,
recipient, private-path, manifest and output checks remain unchanged.

The optional `package_builder.py --resume` package is bound to the single
completed R34 backup and its exact manifest/prepare/backup/STOP hashes. It
reconciles those files locally and remotely, verifies that the encryption
operation directory is empty and that no following intent/receipt exists, and
performs a minimized read-only Git diagnosis before admitting continuation.
Partial encryption, changed programs/receipts, new sessions, changed runtime
or a different Git failure stop the sequence. No historical file is overwritten.

The new package has independent intents and receipts. It reuses the prepared
candidate runtime and the verified images already present on the server,
records explicit adoption of the successful backup, and cannot execute a new
initial backup. It starts encryption into new output directories, then performs
C:/F: copies, isolated database/document recovery, the sole migration49, the
qualified M4 deploy, a distinct post-deploy backup and final checks. A repeated
owner invocation remains read-only reconciliation. No production command is
executed while building or testing this package.

Validation uses actual separate shallow repositories on Windows and Linux,
including reproduction of the old Git failure and both role selections. CI also
creates schema48 and schema49 backups from the respective saved images, uses
the generated selector to protect each set with real age, and decrypts/compares
all three synthetic components. Owner-order, immutable-receipt, partial-progress
and no-replay tests cover the continuation. The production recovery scope and
all limitations from R33/R34 remain unchanged; synthetic CI decryption is not a
new attestation of production C:/F: recovery.
