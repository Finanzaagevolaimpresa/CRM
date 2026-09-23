# PR140 R05 — preparazione del backup e recupero dello schema46

La baseline applicativa di questo passaggio è PR139, commit
3230764a4406182e50d22236bb7e701d0f1b5656 e tree
e25e66e081d92ecf61f8b1422aed456f12128d39. Il successivo rilascio del dossier
richiede la migrazione47. Un backup dello schema43 precedente non copre questa
baseline.

## Contratto circoscritto

Il kit N05 conserva i piani privati vincolati a hash, identità del programma,
commit/tree degli strumenti, commit/tree della sorgente, immagini e destinazione.
Ammette ora due soli conteggi espliciti, 43 e 46. Il conteggio deve coincidere con
l'intero inventario delle migrazioni del commit sorgente: non basta cambiare il
numero in un manifest o in una variabile.

Prima del backup, un conteggio non qualificato o non coerente con il commit
viene rifiutato prima di chiamare Docker e il wrapper. La procedura canonica
continua a richiedere la quiescenza applicativa e l'identità effettiva di database,
immagine, configurazioni, volumi e rete. Il kit non ferma automaticamente l'app.

Nel recupero, tutti i nomi/checksum delle migrazioni ripristinate devono coincidere
con i byte Git della sorgente. Migrazioni mancanti, duplicate, incompiute o
rolled-back sono bloccanti. Schema47 non è ammesso da questa estensione.
La forma del piano e il valore predefinito 43 dei test/operatori storici restano
invariati; 46 deve essere indicato esplicitamente.

Il recupero continua a rifiutare il server produttivo. Crea soltanto risorse
isolate con identità registrate, senza porte pubblicate o rete esterna; non avvia
l'applicazione e non installa configurazioni o chiavi recuperate. Le copie
private e i piani precedenti non vengono sostituiti. Il vecchio
scripts/n05/restore-drill.sh conserva il proprio perimetro43/44.

## Prove richieste sul codice

La CI usa due immagini sorgenti reali e distinte dagli strumenti:

| Schema | Commit dell'immagine sorgente |
|---|---|
|43|ff71b130d2476d77329c07bd492c95c6782162ca|
|46|3230764a4406182e50d22236bb7e701d0f1b5656|

Entrambe eseguono lo stesso percorso completo: migrazioni Prisma reali su un
database sintetico, backup canonico, cifratura age, trasferimento SSH con identità
vincolata, ripristino PostgreSQL/documenti/configurazione/materiale crittografico
sintetici, verifica di vincoli/checksum/ownership/mode, controprove e cleanup
delle sole risorse attribuite. Le controprove sul conteggio precedono la creazione
del backup. La matrice non estende i risultati storici e non usa dati produttivi.

## Evidenze ancora necessarie dal proprietario

La qualificazione degli strumenti non equivale al recupero di un backup reale.
Occorre un nuovo set 46 coerente e identificato, con dump/documenti, snapshot
privato delle configurazioni e copertura del materiale crittografico necessario.
Il proprietario conserva i contenuti e le chiavi; agli agenti arrivano soltanto
ricevute minimizzate.

Prima dell'operazione vanno fissati finestra di quiescenza e ripresa della stessa
app PR139, destinazione privata, identità del recupero isolato e capacità,
commit/tree/hash del kit effettivo e hash del piano. I percorsi operativi storici
non sono nuove attestazioni delle loro condizioni correnti.

Il recupero del set 46 deve produrre la propria ricevuta con 46 migrazioni conformi,
vincoli verificati, integrità e metadati dei documenti, copertura delle
configurazioni/chiavi, sorgente conservata e cleanup attribuito. Nessun accesso
agente a chiavi private o alla custodia è necessario o autorizzato.

Backup produttivo, quiescenza/ripresa, gestione delle copie private e recupero
isolato richiedono il relativo consenso specifico. Questa preparazione non
autorizza migrazione47, deploy, rollback o attivazione su dati reali. Il candidato
applicativo rimane il commit PR141 403c0d69008718f012ddf29cc2298c092be9e465;
l'identità del kit operativo è distinta e deve essere registrata separatamente.
