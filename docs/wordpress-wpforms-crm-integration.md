# WordPress/WPForms → CRM — percorso sostitutivo VNX-02

## Il percorso storico è revocato

La precedente guida pre-N04, il relativo snippet e la route legacy non sono una procedura operativa:
**non devono essere copiati, distribuiti, configurati, testati contro ambienti reali o attivati**.
L'autenticazione a secret singolo e il vecchio payload non soddisfano N04, N10 o N12. Non esiste un
fallback autorizzato verso quel percorso.

Il solo artefatto sostitutivo predisposto è il plugin versionato
`integrations/wordpress/fai-secure-lead-connector`, descritto in
[`vnx02-wordpress-secure-lead-connector-v1.md`](vnx02-wordpress-secure-lead-connector-v1.md). Produce
il body canonico `fai.lead-event.v1`, conserva una coda locale cifrata, firma i raw bytes secondo N12
e applica retry finiti e idempotenti.

## Stato corrente

VNX-02 consegna esclusivamente sorgenti, prove sintetiche e packaging. Il plugin non è installato su
WordPress, non possiede URL/form/privacy reference/key reali, non genera traffico e non autorizza
cutover. L'esempio resta `enabled=false` e usa soltanto valori `SYNTHETIC_*` e `.invalid`.

Qualsiasi installazione o attivazione futura richiede il mandato dedicato, approvazione Legal/DPO dei
riferimenti privacy, provisioning separato delle key, verifica cron/rollback e qualifica isolata. Le
istruzioni tecniche verificabili per quel futuro gate sono incluse nel `readme.txt` del pacchetto.
