# R40: esecuzione del rilascio integrato

La PR176 è integrata in main (`47b9298f8e496c9f8256e5e09362c41918ffd262`).
Il rilascio usa l'immagine immutabile del candidato
`d0d7e9bdc0b4e38ceb31955e32cfca3e1f4ad63f`, albero
`b8b2c2ee55747d0366d6bf5956c52a0a8c322276`, già collaudata e revisionata.
Questo delta riguarda esclusivamente il programma operativo: nessun nuovo
codice applicativo, schema, provider o invio email.

## Sequenza vincolata

1. Ammissione del pacchetto, programma Python e file verificati per SHA256;
   identità del profilo Windows e dischi C/F già registrati. Un secondo lancio
   consulta solo lo stato e non ripete le mutazioni.
2. Immagini verificate; quando l'archivio esatto è già presente viene riusato.
   Caricamento nel deposito immagini e checkout isolato, senza build implicita.
3. Controllo mirato del checkout M5 effettivo, host, utente, risorse, immagine,
   configurazione invariata, ledger49, sessioni e sette caselle.
4. Backup corrente con app ferma, database in funzione e sole query read-only;
   ripresa della stessa app, cifratura e verifica delle due copie su dischi
   distinti. Nessuna revoca delle sessioni o scrittura audit.
5. Ripristino di prova del nuovo backup in risorse isolate senza rete e senza
   volumi di produzione. Verifica database, documenti e ledger completo.
6. Sostituzione della sola app tramite il protocollo N05 già qualificato;
   ambiente copiato byte per byte, nessun migratore. Controlli di salute,
   identità, HTTPS, chiave esistente e conservazione delle sette caselle.
7. Backup successivo distinto, protezione e due copie, ricevuta finale.

Ogni sessione ancora attiva blocca il programma prima dello stop dell'app.
Antonio può terminarla con il normale comando Esci; il programma non la revoca.
Il confronto SHA256 copre tutte le colonne delle sette caselle, restituendo
solamente contatori e digest, mai indirizzi, riferimenti o dati di configurazione.

## Continuità e condizioni di arresto

Non è consentito un ritorno automatico all'immagine M1 presente nel vecchio
archivio: non conserva tutte le restrizioni R37 e la disponibilità M4.
La qualifica aggiuntiva riproduce l'errore applicativo, il ritorno alla precisa
immagine PR175/R37 e la ripresa della medesima immagine R40, usando i due
archivi CI esistenti e dati esclusivamente sintetici. Nessuna immagine viene
ricostruita. Le prove verificano perimetri correnti, storico, documenti e ledger.
Il suo esito deve essere acquisito prima dell'ammissione produttiva.

L'esecutore conserva la ricevuta duratura N05 e si arresta se il candidato
fallisce. Non avvia immagini precedenti né ripristina il database. Un recupero
produttivo richiede l'autorità specifica e il relativo piano vincolato alla
ricevuta di errore, senza allargare l'autorizzazione al normale rilascio.
La coppia è qualificata dal run 36604695948, job 109530619208, artefatto
11050489329. Il candidato conserva il medesimo config digest già verificato
in R63; il nuovo archivio affianca l'immagine R37 necessaria al recupero.
Il run 36605704659 verifica inoltre la pagina M4 sul ritorno R37 e la negazione
a un operatore estraneo. Il download della coppia, se non già acquisita,
avviene automaticamente nel singolo programma proprietario prima dello stop.

Qualsiasi deriva di identità, configurazione, caselle, ledger, risorse o processi
produce STOP e riconciliazione; non esiste ripetizione automatica dopo un esito
incerto. I backup e i dati originali vengono conservati. Il rischio residuo è
un'interruzione dell'app se il rilascio fallisce; database e documenti rimangono
integri e le operazioni successive richiedono verifica delle ricevute.

## Verifica

Test del protocollo e delle negazioni su Windows/Linux, identità degli output
generati, riuso e rifiuto degli archivi alterati, ammissione reale dei modelli
N05, backup schema49 prima/dopo, cifratura e ripristino isolato. Le prove del
programma read-only verificano che sessioni e audit rimangano identici, anche
in presenza di sessioni attive; le scadenze simulate appartengono solo al DB CI.

La costruzione del pacchetto eseguibile richiede CI verde e revisione
indipendente del delta esatto. Il programma Python di avvio verifica tutti i
file prima di importarli e non modifica l'ExecutionPolicy di PowerShell.

Il piano N05 usa il tag originale candidato dell'immagine R37 anche come
immagine di ritorno; la CI sottopone il piano generato al controllo reale
`DockerEngine.image` sulle immagini salvate e nega tag e commit errati.
L'ammissione del profilo SSH, il trasferimento e tutte le fasi usano le stesse
opzioni protette del preflight V2. La controprova Windows/Linux usa solamente
`ssh -G -F` con una configurazione sintetica contraria, senza connessioni.
