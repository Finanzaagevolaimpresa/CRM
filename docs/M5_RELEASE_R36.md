# M5 — rilascio assistito su schema49 invariato

Il delta operativo parte dall'M4 effettivamente distribuito e riconciliato nel
run 86ac8b172083435388800d8625d23f26: commit
e00acfe008c9d2c0504a551198688296797c2491, schema49. Il candidato M5 è
d43b850b3cb4e086f4a986d2dc6a40782d641afe, tree
fe42bd58d509de1ae02d750bc611a83d6bc2f82a, integrato nella PR167 e qualificato
dagli otto workflow sul medesimo HEAD. L'immagine è riusata dall'artefatto
10935172794 del run 36329143320, senza rebuild.

Il pacchetto deriva dai programmi PR170 esatti. Conserva selezione del repository
di protezione per ruolo, hash canonici N05, separazione delle ricevute,
risoluzione OCI verificata, diagnostica minimizzata e arresto sugli esiti incerti.
La configurazione produttiva, la chiave v1 e i sette mittenti non abilitati
rimangono vincolati. Una difformità ferma il pacchetto prima del passaggio.

## Percorso proprietario finito

Un solo avvio normale PowerShell verifica programmi e identità fisiche C:/F:,
acquisisce e trasferisce l'immagine qualificata, riconcilia M4 e prepara M5.
Esegue backup schema49 corrente con revoca auditata delle sessioni, cifratura,
copie C:/F: e recupero isolato del nuovo database/documenti. Il passaggio
migrate confronta il ledger49, richiede assenza di sessioni e prepara/verifica i
modelli congelati per il deploy con sole osservazioni dell'ambiente. Nessun
migratore, comando di migrazione o modifica dello schema è callable. Una lista
di migrazioni non vuota è negata. La ricevuta è prodotta dal dispatcher reale.

Seguono deploy esatto, controlli applicazione/PostgreSQL/HTTPS e registry,
backup49 successivo distinto, cifratura e copie, verifica finale. I precedenti
tentativi M4 e i loro backup/ricevute non sono riutilizzati né sovrascritti.
La ripetizione dello stesso avvio esegue solo riconciliazione read-only.

## Verifica e limiti

I test ereditano le regressioni dei protocolli PR170, aggiungendo le negazioni
sull'autorità di migrazione e i prerequisiti del controllo ledger senza comandi.
CI Windows/Linux; Docker effimero con entrambe le immagini salvate M4/M5,
repository sorgenti shallow distinti, backup49 reali generati per entrambi,
cifratura/decifratura age1.3.2 dei tre componenti sintetici, recupero isolato
e confronto del ledger dopo il metodo generato che non applica migrazioni.
Il downloader è attraversato con lo ZIP originale esatto.

La regressione attraversa dispatcher, Stages.complete e lettura della ricevuta,
generazione effettiva dei modelli e validatori canonici prima del forward.
Soltanto le osservazioni Docker sono sintetiche in questa prova di protocollo;
la stessa sequenza legge inoltre il ledger PostgreSQL reale nel job Docker.
Nessun metodo receipt viene aggiunto alle fixture e nessun modello di output
è precreato. Un modello difforme impedisce di completare la fase.
Gli attributi Git impongono LF ai sorgenti M5; il builder rifiuta CRLF. La CI
confronta gli hash generati realmente su Windows e Linux in un job bloccante.

Il recupero produttivo riguarda il set DB/documenti in chiaro sullo stesso VPS.
Non attesta nuova decifratura produttiva C:/F:, configurazione o applicazione
ripristinata, né perdita totale VPS. Il ritorno M1 qualificato conserva schema49
e dati, ma rende indisponibili M2/M3/M4/M5: sospendere queste lavorazioni e
consegne. Nessun down migration, ripristino distruttivo, provider, mailbox,
consumer, worker, scheduler o API AI attivati.

La prova d'uso produttiva rimane distinta dai cinque casi sintetici CI:
richiede dati, servizi acquistati, responsabili/revisori reali e lavorazioni
Work verificabili. Non inventare pratiche, incarichi, giudizi o consegne.
L'assenza di questi dati non viene dichiarata un PASS del percorso completo.
L'autonomia resta distinta dal rilascio proprietario assistito.

Le operazioni produttive restano quelle del mandato M2–M5 già acquisito;
merge e pacchetto richiedono revisione/CI sul delta operativo esatto.
