# M3 — rilascio assistito dalla produzione M2

Questo delta prepara esclusivamente M3, candidato applicativo
`9508d0da1b9642b02609d7431a984ced7b501e2e`, tree
`a1c92d728b3446159b7be53043dbaa168bf0bb22`. PR161 è integrata in main;
il commit operativo non è l'immagine da distribuire. M4/M5 restano fasi successive.

La sorgente è M2 effettivamente distribuito: commit
`7ab126f8a2ef385c3e720f190eda80f26f61ae39`, container
`ba710299e85034b9ec6633ff44d1c48d38ecddb78494d0e87316b31a5dad0b04`,
schema48, configurazione attestata dalle ricevute R31. Il nuovo preflight
riconcilia nuovamente queste identità, salute, risorse, ledger e configurazione;
le ricevute del 27 settembre non sono una presunzione di salute corrente.

## Sequenza e limiti

Un solo avvio proprietario dal normale PowerShell verifica account, programmi,
alias SSH/host key e identità fisiche C:/F:. Poi acquisisce l'archivio M3 esatto
della CI, trasferisce il pacchetto verificato, riconcilia il server, crea un nuovo
backup schema48, cifra e verifica due copie, prova il recupero DB/documenti in
container isolati, conferma zero migrazioni e distribuisce M3. Seguono postcheck,
nuovo backup post-M3, cifratura, copie C:/F: e ricevuta finale.

Il proprietario non ricostruisce comandi intermedi. Il launcher verifica hash
di manifest, interprete e programmi. L'agente non esegue il launcher né accede
alle chiavi. Nessun nuovo componente privilegiato, modifica ACL, SSH, credenziale,
custodia o sandbox. La revoca auditata delle sessioni avviene durante la
quiescenza, prima del rientro; è necessario un nuovo login personale dopo il rilascio.

Ogni fase ha timeout e marker esclusivo. Un errore ferma la sequenza e acquisisce
la sola riconciliazione; rilanciare lo stesso pacchetto permette soltanto status.
Nessuna fase fallita o incerta è riavviata automaticamente. La Desktop prepara
la ripresa soltanto dopo aver riconciliato i risultati effettivi. Tutti i run,
backup e ricevute precedenti rimangono conservati.

Il nuovo recupero riguarda il set in chiaro DB/documenti sullo stesso VPS,
senza rete né volumi produttivi. Non dimostra decifratura delle copie produttive
C/F, ripristino della configurazione privata, applicazione ripristinata o perdita
totale del VPS. Il ritorno applicativo usa la precisa immagine M1 già verificata
dalla CI M3 su schema48: conserva i dati ma rende M2/M3 indisponibili. Non viene
eseguito un ripristino distruttivo del database.

M3 non attiva il connettore WordPress, i consumer, provider, worker, scheduler o
caselle. Il mapping reale WPForms1265 resta da qualificare separatamente.
Il postcheck tecnico e il successivo smoke autenticato non sostituiscono la
prova di acquisizione reale. Il roundtrip Work M2 resta non attestato in assenza
di una pratica identificata; nessun contratto, pagamento o persona viene inventato.

## Provenienza e controlli del delta

`generate.py` ricompone solo programmi Git esatti: PR158 per gli helper originali,
PR160 iniziale per la sequenza completa, PR166 per correzioni di backup,
cifratura48 e validazione delle evidenze. Non cambia i file storici.
Le immagini non sono ricostruite. I config ID, commit/tree e hash archivio sono
letti dalla ricevuta CI già acquisita; il manifest OCI viene derivato univocamente
dal medesimo archivio e verificato insieme a piattaforma, layer e label prima
dell'uso. Un riferimento al solo tag non viene ammesso.

La qualifica del delta usa Docker29.6.1/containerd, immagini M3 salvate, backup
generato, age1.3.2 e recupero isolato schema48. Le prove protocollo Windows/Linux
verificano il piano canonico prima della mutazione, errori non ripetibili,
sequenza proprietaria e binding. Il pacchetto finale richiede PASS del Revisore
e CI sul medesimo HEAD; la sua presenza non attesta un rilascio eseguito.
