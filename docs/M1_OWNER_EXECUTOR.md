# M1: capability locale di ammissione R18

Il profilo con denied-read mantiene il processo shell di Codex nella sandbox;
l'elevazione equivalente non rende disponibile il profilo SSH proprietario.
Questo delta prepara una diversa **capacità MCP esplicita, da revisionare e
approvare prima dell'installazione**. Non modifica la sandbox e non espone una
shell fuori sandbox. Non è ancora il programma completo di rilascio M1.

## Ambito installabile

Tre strumenti senza argomenti:

| Strumento | Effetto |
| --- | --- |
| `fai_crm_m1_status` | Identità della build e verifica locale dell'installazione. Nessuna connessione. |
| `fai_crm_m1_observe` | Un'osservazione SSH read-only del target vincolato. |
| `fai_crm_m1_reconcile` | Dopo errore/incertezza, riconcilia lo stato locale e svolge una nuova osservazione read-only. |

Non esistono strumenti backup, migrazione, deploy, ripristino, upload, download,
lettura di percorsi arbitrari o provisioning. Tali operazioni M1 conservano le
autorizzazioni acquisite, ma non sono implementate da questa prima capacità.
Le vecchie entry point backup46 non sono raggiungibili da questo eseguibile.

Il candidato applicativo rimane `fb645e014653ee87dc64f2439970967192f91b62`.
La baseline osservabile è PR139/schema46, con identità di engine, container,
immagini e rete e l'inventario completo delle 46 migrazioni incorporati nella
build privata. Non pubblicare quel binding o un pacchetto produttivo nella PR.
Il binding è un'aspettativa storica da riconciliare, non una prova di salute attuale.

## Confine di fiducia

- Il binario C# usa .NET Framework di Windows e incorpora sorgente Python e
  binding. Nessun percorso, programma, host o argomento shell proviene dall'MCP.
- Installazione sotto `C:\Program Files\FAI-CRM-M1-R18\<manifest-hash-prefix>`.
  Proprietario del codice/configurazione: Administrators. Scrittura consentita
  solo a SYSTEM/Administrators; proprietario Windows e sandbox hanno sola lettura.
  Un deny di scrittura riguarda esclusivamente i nuovi oggetti della capacità.
- Il provider deve essere avviato da Codex nel normale account Windows
  proprietario. Rifiuta un'identità sandbox o un token amministrativo. La
  documentazione MCP descrive l'integrazione stdio, ma **non prova che questo
  host la avvii nel contesto richiesto**: servirà la qualifica effettiva.
- File di ammissione e manifest sono protetti; hash di binario, profilo SSH e
  client SSH sono verificati a ogni operazione. Link/reparse point sono rifiutati.
- Viene usato solo OpenSSH di sistema, il profilo esistente di Utente e
  `fai-crm-prod`. Alias ammesso: `faiadmin@desk.finanzaagevolaimpresa.it:22`.
  L'osservatore richiede poi hostname `fai-crm-prod-02`, uid 1000 e utente faiadmin.
- Host key obbligatoria nel normale `~/.ssh/known_hosts`, non aggiornata.
  Forwarding, proxy, control socket, agent, comandi locali e direttive dinamiche
  del profilo sono vietati. Il componente non ripara configurazioni incompatibili.
- Il materiale SSH viene utilizzato internamente da OpenSSH; il componente non
  legge, copia o esporta file di chiave privata. L'agente riceve solo ricevute.
  `agentRealKeyAccess=false` non significa che OpenSSH autentichi senza credenziale.
- Nessun accesso a FAI-Custodia; nessun cambiamento di policy, ACL preesistenti,
  credenziali, firewall, servizio Windows, scheduler o porta d'ascolto.
- Un server MCP registrato nel config utente è visibile anche ad altre task
  locali di quell'utente: questa versione consente comunque solo le tre
  operazioni fisse. Non rivendica un'identità di task autenticata dal protocollo.

## Tempi, errori e ricevute

Il lock locale impedisce sovrapposizioni anche fra due istanze MCP. Un marker viene
conservato prima della connessione; un errore richiede riconciliazione. La finestra
di 150 secondi del tentativo precedente deve essere scaduta prima di riconciliare.
Non vengono cancellate ricevute: marker riconciliati/completati cambiano nome.

Espansione alias: 15 s. Osservazione SSH: 135 s; il payload remoto ha un termine
assoluto di 120 s e ogni comando un limite di 15 s. SQL usa transazione read-only,
statement timeout di 8 s e lock timeout di 2 s. Un Windows Job Object vincola la
vita del processo figlio e dei discendenti; nessun payload remoto è inviato prima
dell'assegnazione al job. L'ambiente del solo processo provider/figlio è ripulito;
non cambia l'ambiente persistente dell'utente o del sistema.

La ricevuta minimizzata rimane in `C:\ProgramData\FAI-CRM-M1-R18`, scrivibile dal
proprietario ma non dall'agente. Non contiene environment, log grezzi, documenti,
dump o valori/digest di chiavi applicative. I campi ammessi sono verificati anche
dal lato Windows; campi imprevisti causano STOP senza restituire il contenuto.
Gli errori SSH distinguono DNS, host key, autenticazione e connessione; gli errori
remoti riportano codici fissi. Non si deduce l'esito di un backup da questi codici.

## Prerequisiti M1 acquisibili

L'osservatore verifica baseline, risorse, salute, ledger46 completo/checksum, gate
esterni, conteggio sessioni e spazio. Per step-up legge versione/presenza dal
runtime e il registro `ApplicationKeyVersion` in transazione read-only. Il
confronto del digest avviene solo sulla VPS; non viene restituito all'agente.
È un'ispezione in memoria della configurazione applicativa esistente, senza
file di chiavi né provisioning. Una mancata corrispondenza resta un dato da
riconciliare: non abilita automaticamente creazione o rotazione di segreti.

Il recipient pubblico age di produzione rimane `UNATTESTED`: non viene inventato
né ricavato da fixture sintetiche. L'osservazione non legge il contenuto dei backup.
L'esito completo include sempre `releaseAdmitted=false`; salute e connessione
non provano recuperabilità del nuovo set o ammissione del rilascio.

## Preparazione e verifica

`Build-M1Executor.ps1 -BindingPath <binding> -OutputDirectory <directory-nuova>`
compila senza pacchetti esterni e produce exe, installer, uninstaller e manifest.
Un pacchetto produttivo usa il binding privato e un hash del manifest separatamente
revisionato. Gli eseguibili compilati sono artefatti locali, non file Git.

`Test-M1Executor.ps1` esegue solo fixture: observer sintetico, rifiuto di target e
input arbitrari, ACL in memoria, minimizzazione degli errori, processo/descendenti
terminati al timeout, protocollo stdio reale e rifiuto di pacchetti alterati.
La prova stdio usa una build non installata e verifica il rifiuto prima di SSH.
Non usa chiavi vere, non installa la capacità e non modifica il CRM.

La CI dedicata è separata dalla qualifica applicativa M1 già acquisita. Le CI
generali obbligatorie della repository non sostituiscono questi test operativi.

## Decisione di installazione e rimozione

Solo dopo revisione del delta, serve la decisione specifica di installare questa
capacità read-only. Il mandato non approva implicitamente componenti privilegiati.
L'installer richiede il contesto amministrativo esplicito del proprietario: non
si autoeleva e non viene lanciato dalla shell agente fuori sandbox.

Il comando proprietario deve leggere **una volta** i byte dell'installer,
verificarli contro lo SHA256 approvato ed eseguire quei medesimi byte in memoria,
passando percorso del pacchetto, hash del manifest e riferimento autentico alla
revisione. Evitare la sequenza vulnerabile “hash del file, poi riapri/esegui file”.
L'installer verifica e conserva in memoria tutti i byte prima delle scritture,
crea ACL protette alla creazione, poi aggiunge un'unica sezione MCP in fondo al
config. I byte precedenti, inclusa la custodia, restano intatti. Nessuna copia del
config completo viene esportata. Un percorso occupato ferma l'installazione.

La registrazione non è una ricevuta di connessione: dalla stessa task si deve
chiamare `status`, poi `observe`, e riconfermare dopo una normale riapertura della
sessione. Il nuovo `processInstance` aiuta a distinguere le istanze; da solo non
prova che l'app sia stata riaperta. Nessun rilascio assistito chiude questo punto.

Per disinstallare: fermare questo solo server MCP e avviare l'uninstaller protetto
con il suo hash manifest nel contesto amministrativo del proprietario. Rimuove
solo l'esatta sezione aggiunta se ancora riconoscibile e i file verificati della
propria directory, senza cancellazioni ricorsive. Modifiche concorrenti o file
imprevisti fermano la rimozione. Ricevute, custodia, SSH e backup sono conservati.
Un'installazione parziale non viene sovrascritta o ripetuta automaticamente.

## Fonti del protocollo

- [MCP in Codex e nell'app desktop](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Trasporto stdio MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [Contratto degli strumenti MCP](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
