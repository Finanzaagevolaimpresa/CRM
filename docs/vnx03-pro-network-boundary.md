# WPForms Pro: confine proposto fra build e runtime

Il banco Pro ora si arresta fra `pro_build_images` e il primo `compose up`
di PostgreSQL/MySQL, se la verifica della rete non è conclusa positivamente.
Questo è un componente di preparazione. Non conferisce autorità di esecuzione,
non qualifica il banco commerciale e non modifica l'applicazione CRM.

## Contratto distinto dalle prove precedenti

`build-boundary-v1` misura una proprietà più circoscritta del requisito storico
«bridge sempre vuota anche durante la build». **Non è equivalente** a quel
requisito e non trasforma precedenti STOP in PASS. Richiede una nuova decisione
umana sul metodo e sulla singola esecuzione, legata al candidato e al driver
locale esatti. L'opzione `VNX03_PRO_NETWORK_CONTRACT=build-boundary-v1` seleziona
il metodo; non è un consenso umano né un grant. Senza selezione il runner Pro
si arresta prima del preflight Docker. Il profilo Lite resta invariato.

Il driver esterno deve conservare separatamente gli endpoint osservati durante
la build, senza attribuirli al builder per nome, forma dell'ID o coincidenza
temporale. Il fatto che un endpoint scompaia non ne dimostra il proprietario.
L'eventuale accettazione di endpoint di sandbox non attribuiti, limitata alla
fase build, va dichiarata nella decisione sul nuovo metodo; non può essere
dedotta da questa implementazione o dal consenso a un metodo precedente.

## Condizioni bloccanti prima del runtime

1. Il preflight esistente vincola checkout, immagini/input, Engine, context,
   endpoint locale, builder e nomi delle risorse del progetto.
2. `prepare` registra una baseline con bridge vuota e vincola source, tree,
   progetto e trasporto. Fallimenti non abilitano neppure il cleanup del progetto.
3. La build esistente termina con codice zero. Un errore non viene ritentato.
4. `admit` verifica l'hash della baseline trattenuto dal processo Bash, binding,
   identità/Created/configurazione bridge, metadati di stato dei container
   storici e inventari di volumi/reti. Qualsiasi divergenza blocca l'avvio.
5. Sono richiesti due campioni consecutivi di bridge vuota distanziati di un
   secondo. L'intera lettura dopo la build ha un budget massimo di 30 secondi,
   con ogni comando limitato a cinque secondi e al tempo residuo. Solo endpoint
   di sandbox non attribuiti possono essere osservati in attesa che scompaiano;
   un container dell'Engine o un endpoint orfano bloccano subito. Letture
   fallite, incomplete o tardive non equivalgono a rete vuota.

Le osservazioni minimizzate precedono gli assert. I file sono esclusivi e un
secondo tentativo nello stesso percorso è rifiutato. La ricevuta
`ADMITTED_BOUNDARY_ONLY` ha sempre `runtimeQualified=false` e
`endpointAttributionProven=false`: attesta solo il confine campionato. Le
letture non sono una transazione dell'Engine e non dimostrano l'assenza di un
evento fra due campioni. Inventari di volumi/reti provano identità e presenza,
non integrità dei dati nei volumi.

## Vincoli del futuro driver locale

Il driver deve negare tutti i consensi precedenti, vincolare il nuovo contratto
oltre a HEAD/tree/sigillo, monitorare la fase build, acquisire e verificare la
ricevuta di confine e controllare nuovamente la rete durante runtime e dopo
cleanup. Nessun endpoint sulla bridge predefinita è ammesso in queste ultime
fasi. Restano i limiti autorizzati del progetto, le reti dedicate, le porte
loopback, la custodia del pacchetto e il cleanup dei soli oggetti del banco.
Non può riparare/reimpostare reti o attribuire endpoint ignoti a risorse proprie.
La sola ricevuta di confine non sostituisce quelle verifiche né il nuovo grant.

## Provenienza e limiti

Le sorgenti Moby al commit `6a43e3d5afddf4111da0f864bbc7cae5d7e95001`
documentano un possibile endpoint di build sulla bridge e rimozione asincrona:
[executor](https://github.com/moby/moby/blob/6a43e3d5afddf4111da0f864bbc7cae5d7e95001/daemon/internal/builder-next/executor.go),
[provider Linux](https://github.com/moby/moby/blob/6a43e3d5afddf4111da0f864bbc7cae5d7e95001/daemon/internal/builder-next/executor_linux.go).
La mappa `Containers` di network inspect usa la sandbox ContainerID e conserva
separatamente EndpointID: [network](https://github.com/moby/moby/blob/6a43e3d5afddf4111da0f864bbc7cae5d7e95001/daemon/network.go).
Queste fonti non attribuiscono gli endpoint di una precedente esecuzione.

I test offline sostituiscono processi Docker/rete e verificano dinieghi,
timeout, minimizzazione e l'effettivo ordine Bash prima dell'avvio DB. La CI
esegue tali test e conserva le prove Lite/N14 esistenti. Non è una nuova prova
WPForms Pro sull'MSI. Nessuna immagine, schema, dipendenza, dato reale o
configurazione produttiva cambia. Recupero del solo delta tramite normale PR
di revert; nessun rollback o riutilizzo automatico dei vecchi driver.
