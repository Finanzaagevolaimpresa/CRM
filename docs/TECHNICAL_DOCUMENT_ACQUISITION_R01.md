# Acquisizione privata dei documenti tecnici approvati

L'Admin personale può acquisire nel fascicolo un deposito già approvato con `APPROVE_PRIVATE`. Il riepilogo richiede classificazione, titolo e scadenza facoltativa. La conferma personale riguarda la versione e i byte esatti: non crea destinatari, concessioni, avvisi o email.

## Percorso

1. Aprire la revisione del deposito approvato e scegliere «Acquisisci nel fascicolo».
2. Classificare come documento tecnico, contratto, pagamento o altro riservato; verificare titolo, impronta e scadenza nel riepilogo.
3. Confermare con l'autorità personale già qualificata `technical-assignment` e step-up corrente.
4. Nel fascicolo aprire «Documenti acquisiti e visibilità». Per mostrare una versione a un'altra persona usare la condivisione selettiva del cliente/pratica oppure l'incarico tecnico già esistente. Persona, versione, download e scadenza restano scelte distinte. Nessuna nuova versione eredita accesso.

Il documento resta escluso dalle letture ordinarie, anche dell'Admin generico. Il titolare personale può consultarlo nel percorso dedicato. Contratti e pagamenti restano limitati ad Admin/Amministrazione anche quando selezionati esplicitamente. L'assegnazione tecnica non concede l'intero fascicolo o documenti di altri progetti.

I formati con anteprima privata e selezione documentale già qualificata sono PDF, PNG, JPEG e testo UTF-8. Gli altri formati ammessi al deposito possono essere acquisiti e scaricati privatamente dall'Admin; la loro condivisione è un residuo distinto e non viene abilitata ampliando implicitamente i formati delle concessioni esistenti.

## Persistenza e autorizzazione

La nuova migration `20261024190000_technical_document_acquisition_v1` porta 67→68 e aggiunge `TechnicalDocumentAcquisition`, inizialmente vuota, senza binding o grant. Conserva le 67 migration e tutte le righe precedenti. Document, versione 1, provenienza firmata e audit minimizzato sono inseriti nella stessa transazione serializable. Il file privato esistente viene referenziato senza copia o trasferimento.

Il registro lega deposito, revisione, decisione, attore/sessione, contesto, checksum e versione immutabile. Trigger differiti impediscono righe orfane, versioni aggiuntive, cambi di classificazione o rimozioni della barriera privata. Restano consentiti i soli incrementi tecnici dell'epoch di invalidazione. Il registro non può essere modificato, cancellato o svuotato.

Ogni conferma rilegge autorità, sessione, incarico, revisione, proprietà/perimetri, stato del contesto, expiry e byte privati. Un comando concorrente differente non acquisisce due volte lo stesso deposito. La risposta persa si riconcilia con il comando originale, senza nuova acquisizione. Gli accessi selettivi ricontrollano provenienza e contesto; revoca, scadenza, archivio, variazioni rilevanti o byte alterati chiudono l'accesso.

## Qualificazione prevista sull'HEAD esatto

- Contratti puri: decisione, firma, provenienza, proiezione e barriera ordinaria.
- CI PostgreSQL: 19 regressioni del deposito/revisione e 11 casi di acquisizione, concorrenza, audit, classificazione, byte alterati, revoca e destinatari distinti.
- CI browser nativo: 7 scenari, inclusi caricamento/revisione/acquisizione, scelta della versione tecnica, dinieghi e risposta persa; riscontri desktop/mobile.
- SQL67 storico qualificato sul suo schema immutabile; SQL68 qualificata da 67 con errore atomico iniettato, replay/base errata, hash di tutte le righe preesistenti, struttura e deriva Prisma invariati.
- PR140: immagine candidata/merge, riavvio compatibile schema68, provenienza e byte privati conservati, dinieghi dopo riavvio.

Questa descrizione non attesta esiti non ancora ottenuti. I risultati devono essere registrati per commit/tree esatti nella consegna della delivery.

## Rilascio

Non autorizzato da questo file. Servono piano concreto, riesame pertinente, consenso specifico SQL68/rilascio, CI e immagine del merge, preflight fresco e postflight. Il target resta `fai-crm-prod-02` / `fai_crm`. Nessun nuovo backup, restore DB, down-migrate o ritorno a codice incompatibile con schema68. Un esito ambiguo blocca per riconciliazione; un errore dopo SQL68 può richiedere app ferma fino a correzione compatibile. Nessun dato reale viene usato come fixture o creato per il collaudo.
