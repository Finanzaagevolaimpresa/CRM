# R18: canale a file per il componente proprietario già installato

Il provider MCP della build 954db17 risulta installato e inizializzato nel
catalogo globale dell'app, ma non è disponibile fra gli strumenti della task
01a0c20b-b096-78a3-b6f6-db9153b914fe. La causa non è dimostrata e non viene
attribuita a SSH, timeout o al difetto separato dei codici errore MCP.
Questo delta prepara un **nuovo trasporto esplicito da approvare prima
dell'installazione**; non interviene nelle API interne o nell'interfaccia di Codex.

## Effetto e limite

Un processo nel normale account Windows del proprietario riceve da una casella
locale soltanto status, observe o reconcile, senza argomenti. Avvia l'esatto
provider installato M1Executor.exe con il protocollo stdio già verificato.
Gli hash del core, del suo manifest, dell'osservatore e del binding produttivo
sono costanti compilate. La vecchia installazione e la registrazione MCP
rimangono intatte, così come configurazione Codex, sandbox, custodia e SSH.

Il candidato resta fb645e014653ee87dc64f2439970967192f91b62.
Il canale **non implementa backup, copie, recupero, migrazioni, deploy o
provisioning**. Recupera la capacità di ottenere le evidenze produttive necessarie
per completare il pacchetto operativo M1. La sua installazione non dimostra
l'esecuzione autonoma né l'ammissione del rilascio.

## Installazione specifica e persistenza

Richiede la decisione specifica prevista nel mandato R18 per un nuovo componente:

- codice e ammissione sotto
  C:\Program Files\FAI-CRM-M1-CHANNEL-R18\<prefisso-hash-manifest>;
- ricevute e stato sotto C:\ProgramData\FAI-CRM-M1-CHANNEL-R18, scrivibili
  dal proprietario, in sola lettura per CodexSandboxOffline;
- unica casella scrivibile dall'agente sotto il workspace autorizzato:
  C:\Users\Utente\.codex\visualizations\2026\09\21\01a0c20b-b096-78a3-b6f6-db9153b914fe\m1-owner-channel-r18;
- unica voce FAI-CRM-M1-CHANNEL-R18 in
  HKCU\Software\Microsoft\Windows\CurrentVersion\Run, contenente il solo percorso
  protetto dell'eseguibile senza argomenti. Si avvia all'accesso Windows del
  proprietario, con token ordinario. Nessun servizio, task schedulato, porta
  d'ascolto o token amministrativo persistente.

Le ACL vengono assegnate solo agli oggetti nuovi, già alla loro creazione.
Codice e configurazione sono di Administrators e non modificabili dall'agente
o dal normale processo proprietario. Non vengono ampliate ACL preesistenti.
Il processo rifiuta account sandbox e token amministrativi. Il campo taskId
vincola il formato e il destinatario operativo, **non autentica l'identità della
task**: processi con gli stessi diritti sulla casella possono chiedere soltanto
le medesime tre letture. Nessuna credenziale viene consegnata all'agente.

Build-FileChannel.ps1 prepara un pacchetto separato dal core storico.
New-FileChannelLauncher.ps1 genera un unico avvio proprietario .cmd/.ps1
legato al manifest approvato e al riferimento del revisore. Il proprietario
lo avvia nella normale sessione Windows e conferma UAC una volta. Il processo
amministrativo verifica e usa i medesimi byte in memoria dell'installer; dopo
l'installazione il lanciatore originario, non elevato, avvia il componente.
La prima osservazione viene richiesta da Codex, non dal lanciatore.
Un'installazione parziale/occupata viene riconciliata, mai sovrascritta.

## Richieste, errori e riapertura

La casella ha un solo request.json. Il client pubblica atomicamente un JSON
di massimo 2 KiB con protocollo/candidato/task fissi, sessione corrente, nonce
esadecimale e scadenza entro 5 minuti. Nessun host, file, ambiente, programma
o comando può essere trasmesso. Il processo conserva un lock esclusivo per
tutta la propria vita, ed esegue una sola operazione alla volta.

Il runtime vincola la casella alla sua identità NTFS registrata nell'ammissione.
Prima di leggere contenuti verifica il file aperto: dimensione, tipo, percorso
risolto e numero di hard link. I reparse point sono rifiutati e gli handle delle
directory antenate restano aperti senza condivisione di cancellazione, impedendo
la sostituzione dei percorsi durante l'uso. Il medesimo blocco protegge i genitori
durante l'installazione. L'input resta non fidato anche dopo questi controlli.

Un claim viene reso durevole prima della chiamata. Ricevute e marker sono
pubblicati solo dopo il flush completo, con creazione esclusiva e senza
sovrascrittura. I file temporanei hanno nomi unici. All'avvio e prima delle
operazioni, sotto il lock, le pubblicazioni interrotte vengono archiviate
senza leggere o alterare i loro byte; costituiscono un blocco durevole fino a
una riconciliazione riuscita. Anche un nonce con claim parzialmente scritto
rimane riservato dopo la riconciliazione e non viene riutilizzato.
Una richiesta già conclusa restituisce la ricevuta esistente;
una richiesta interrotta non viene rilanciata. STOP/incertezza richiedono
reconcile; status non cancella il blocco. I marker precedenti sono conservati.
La riconciliazione esegue una nuova lettura, senza consumare tentativi di backup.

Il figlio e i discendenti sono contenuti in un Windows Job Object: timeout
170 secondi, più assestamento massimo di 5 secondi. Si riusa il contenimento
già testato del core. Il client attende 185 secondi e poi conserva la richiesta,
senza retry. collect legge soltanto la ricevuta dell'ultima richiesta.
Un esplicito reconcile può archiviare i byte di una richiesta ancora pendente
e inviare una nuova lettura con un nonce diverso.

Il client mantiene un lock Windows esclusivo durante pubblicazione, attesa e
raccolta. Il consumo apre la richiesta con accesso lettura/cancellazione senza
condividere scrittura o cancellazione, verifica quei byte e marca per rimozione
lo stesso handle. Non usa più una cancellazione per percorso successiva al
confronto. Client concorrenti ricevono CHANNEL_CLIENT_BUSY; anche uno scrittore
che ignori il lock non può sostituire il file durante verifica e consumo.
Il lock del client viene liberato dal sistema anche dopo un'interruzione.

Ogni istanza proprietaria ammette al massimo 128 richieste valide.
Una nuova istanza ha un nuovo sessionId: gli input di sessioni precedenti o
scaduti non vengono eseguiti. La normale chiusura/riapertura di Codex non richiede
di riavviare il componente. Un file ready non è una prova di vitalità: occorre
una nuova ricevuta della stessa task, prima e dopo la riapertura effettiva.
Windows può ritardare/disabilitare l'avvio all'accesso; non viene dichiarato
garantito senza osservazione.

La ricevuta contiene solo campi ammessi e codici fissi. Errori grezzi, ambiente,
stdout inatteso, documenti, backup e chiavi non vengono esportati. Il core
continua a verificare profilo SSH, host key, alias, target e baseline PR139/schema46.

## Verifiche e rimozione

Test-FileChannel.ps1 prova richieste ostili, output alterato, replay, morte
simulata del processo, blocco dopo STOP, riconciliazione, sanitizzazione,
contenimento dei percorsi, hard link, writer concorrente, pacchetto alterato
e rifiuto dell'eseguibile reale non installato. Il client ha test separati di
timeout/raccolta/ricevute e conservazione dei byte.
Le regressioni della revisione simulano pubblicazioni interrotte di ready,
pending, stop e claim (formato iniziale e temporanei unici), verificando il
confronto byte per byte e l'assenza di replay. La regressione collect/reconcile
esercita i veri handle Windows con due thread e uno scrittore non cooperante.

Nella sandbox locale la lettura degli antenati del profilo Windows è negata:
-FixtureBoundaryOnly limita il test degli handle alla directory sintetica.
Questa opzione **non esiste nel programma installabile**. La CI esegue il test
completo degli antenati senza tale opzione; questa evidenza deve essere verde
prima della revisione. Nessun test installa il componente, legge chiavi o
apre connessioni remote.

L'uninstaller protetto richiede il proprietario/UAC, verifica manifest,
inventario, hash e voce Run, poi segnala l'arresto ordinato del solo canale.
Attende al massimo 185 secondi e si ferma se il processo è ancora attivo.
Rimuove esclusivamente la propria voce Run e i cinque file verificati, senza
cancellazioni ricorsive. Stato, ricevute, casella, core MCP, SSH, custodia e
backup restano conservati. Non termina processi SSH o operazioni in corso.

## Riferimenti

- [CreateFile e modalità di condivisione](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
- [Identità e numero di link del file aperto](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information)
- [Avvio per utente Run/RunOnce](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)
- [Consumo mediante lo stesso handle verificato](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)
