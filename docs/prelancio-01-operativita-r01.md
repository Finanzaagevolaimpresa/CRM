# PRELANCIO-01 — candidato operativo, 5 ottobre 2026

Mandato: completare gli incrementi pre-lancio sulla R42 esistente e sull'MSI.
Base GitHub verificata: `9c30235719831dd4881e65ce843d799d00b964e7`, tree
`9e80c813f74b4269dd83646de7b15e682e9f1d37`. Le PR precedenti restano chiuse.
Questo documento descrive software candidato e decisioni ancora distinte;
non certifica un rilascio o un ingresso reale dal sito nel CRM.

## Avvio e sessioni

`assertRegistryActivationReady` conserva la protezione di prima attivazione:
nessuna sessione valida non revocata. `assertRegistryStartupReady`, chiamato
dalla strumentazione Next in modalità registry, riconosce una precedente
attivazione solo mediante una ricevuta operativa in `AuditLog`: evento
`internal_session_registry_continuity`, `entityType=InternalSessionRegistry`,
`entityId=registry`, attore identificato e `after={enabled:true,version:1,mode:"registry"}`.
Si legge l'evento più recente del perimetro; due eventi con lo stesso timestamp,
un evento non riconosciuto o un payload malformato impediscono l'avvio.
Una ricevuta assente usa la protezione originaria; una ricevuta disabilitata,
di versione sconosciuta o un archivio non leggibile impediscono l'avvio.
Le decisioni si aggiungono senza sovrascrivere la storia; `enabled:false` in una
nuova ricevuta invalida quella precedente. Non si modifica `ApplicationFeatureGate`,
la cui allowlist rimane invariata. Schema e 49 migrazioni restano identici alla base.
La ricevuta non viene mai creata o aggiornata da startup, login o session refresh.
Lettura delle sessioni e autorizzazione di ciascuna richiesta restano obbligatorie.

Il rilascio richiede una decisione separata sulla registrazione iniziale della
ricevuta: non è una migrazione e non è compresa nel solo consenso al deploy.
Per una prima attivazione, eseguire il controllo originario a zero sessioni e
registrare la ricevuta nella stessa operazione controllata, con audit e identità
Admin verificata. Per l'installazione già in registry occorre invece riconciliare
esplicitamente l'attivazione documentata R108: verificare immagine/configurazione
effettive, assenza di ritorni a legacy e continuità delle prove. Solo dopo tale
verifica autorizzata si può inserire la singola ricevuta audit, senza
modificare o revocare sessioni. In assenza di prova non registrare la ricevuta.

Qualunque futuro passaggio a legacy richiede disabilitazione esplicita della
ricevuta PRIMA del cambio. Il nuovo runtime verifica la continuità anche all'avvio
legacy e nega tale avvio se la ricevuta è ancora abilitata o non valida.
Questa verifica non esiste nel vecchio runtime R108: il piano di rollback deve
eseguire il controllo prima della sostituzione. Una successiva riattivazione passa nuovamente dal
controllo originario a zero sessioni; la ricevuta precedente non è riutilizzabile
come consenso. Un rollback verso R108 in registry conserva la sua vecchia
guardia: con sessioni valide il riavvio non è qualificato. Nessun rollback,
logout forzato o revoca automatica viene introdotto dal candidato.

Prove: test unitari di prima attivazione/ricevuta invalida/DB indisponibile;
test PostgreSQL con due processi nuovi che eseguono la strumentazione effettiva,
conservazione integrale delle sessioni e degli audit durante l'avvio, login,
revoca e dinieghi per sessioni revocate, scadute e cookie legacy. Solo database
effimero con sentinella, mai database produttivo.

## Contratto firmato e cliente sospeso

Lo stato della firma e l'operatività sono mostrati separatamente. Una firma
collegata senza incasso documentato resta «in attesa di pagamento verificato».
Un semplice stato `incassato` e un riferimento a un documento non diventano una
certificazione del pagamento: il messaggio richiede verifica della prova e
autorizzazione separata all'avvio. I dinieghi individuali e il tetto di ruolo
contratti/pagamenti restano applicati anche al nuovo riepilogo.

Il cliente con stato persistito `sospeso` mostra un impedimento generico.
Creazione/avanzamento di un servizio, handoff dell'acquisto, avvio della pratica
e creazione/modifica/cambio stato di una pratica tecnica in uno stato operativo
rileggono e bloccano il cliente nella transazione prima delle scritture.
Sono ancora possibili la preparazione di una richiesta e la sospensione/chiusura;
per le pratiche tecniche restano ammessi `da_progettare`, `respinta`, `archiviata`.
La pagina aperta prima della sospensione non evita la rilettura transazionale.
nessuna etichetta di servizio può aggirare la sospensione. La firma da sola non
sospende o riattiva automaticamente un cliente: la decisione sul dato reale
rimane esplicita, tracciata e separata dall'installazione del software.

Raccordo puntuale del caso SILVER già acquisito, da eseguire solo con consenso
specifico alle scritture e valori correnti nuovamente verificati:

1. Individuare la sola scheda cliente e il contratto esistenti. L'originale firmato
   è acquisito **solo localmente sull'MSI**: il controllo del 05/10 non lo trova
   negli allegati CRM. Dopo autorizzazione specifica, verificare di nuovo l'assenza
   per hash e caricare una sola volta l'originale con classificazione finanziaria
   riservata, versione documentale e audit. Se nel frattempo è già presente,
   verificare e riusare quella versione; non creare duplicati.
2. Verificare hash/versione e collegare la firma certificata del **24/09/2026**
   alla versione effettivamente presente nel CRM.
   Il **21/09/2026** riportato nell'intestazione non è la data di firma.
   Usare la registrazione firma esistente con controllo versione e audit.
3. Impostare la sola scheda cliente esistente a `sospeso`, con audit e confronto
   dello stato precedente. Il contratto conserva la firma; il nuovo riepilogo
   ne espone la sospensione operativa. Conservare il pagamento come atteso.
4. Assegnare un responsabile operativo esistente, verificato e autorizzato alla
   presa in carico, e la prossima azione «verificare la ricezione del pagamento».
   Nome e scadenza non sono inventati: confermare il responsabile già registrato
   e la scadenza concordata nel preflight del caso.
5. Rileggere le stesse righe e gli audit; l'unico nuovo documento ammesso è
   l'eventuale originale previsto al punto1, con la sua versione e il suo audit.
   Verificare assenza di duplicati, nuovi clienti, contratti, pagamenti, incassi,
   servizi o pratiche. Non inventare una riga Payment per indicare l'attesa.
   I ruoli esclusi vedono solo
   l'impedimento, mai importi, dettagli della firma o motivazioni economiche.

Nessun dato del cliente, identificatore privato o documento è incluso nella PR.
La successiva prova di pagamento richiederà una nuova decisione sull'avvio;
non è prevista una riattivazione automatica.

## Contatori

Stile circoscritto al componente effettivo: navy, ciano e verde, bordi discreti,
cifre tabulari e barre relative al massimo della propria area. Nessuna barra
attesta una percentuale di completamento; non vengono introdotti trend, target,
indicatori LIVE o numeri di fantasia nell'app. Query, valori del server e filtri
di ruolo restano invariati. Il testo accessibile resta stabile mentre anima
solo la copia decorativa; `prefers-reduced-motion` disabilita il movimento.

Il banco `tests/prelaunch-ui` importa il componente e il CSS effettivi con dati
esplicitamente sintetici; non è una riproduzione grafica separata. Produce nove
screenshot (320/768/1440px × zero/positivi/grandi), verifica valori, overflow,
tastiera/focus, barre non semantiche e riduzione del movimento. Le altre suite
del repository verificano i perimetri di ruolo e le pagine CRM con PostgreSQL.

## Qualificazione e autorizzazioni

Le prove definitive sono legate al commit della PR: CI generale, candidato N14
schema49, firma, riservatezza finanziaria, contatori e controlli pertinenti.
L'ambiente MSI ha Node 24.18.0/npm 11.16.0; la CI usa `.nvmrc` e lockfile del
repository. La suite completa Windows contiene controlli POSIX e hash dei file
con checkout CRLF: il suo esito non sostituisce quello Linux previsto.

Riesame P2-01/P2-02: aggiunte prove PostgreSQL sugli stati tecnici e sulla
sospensione concorrente, più prove browser delle tre azioni effettive per Admin
e consulente con pagina già aperta, righe/audit invariati al diniego e percorsi
di preparazione/arresto ancora ammessi. La precisazione sul singolo upload non
approva né sostituisce il piano operativo privato.

Il controllo dipendenze del 06/10 ha rilevato source-map-js1.2.1, dipendenza
transitiva: [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
Il lockfile aggiorna esclusivamente questa risoluzione alla patch1.2.2 con
integrità npm verificata; package.json, schema e49 migrazioni restano invariati.
Audit e CI completi devono superare nuovamente i controlli su questo HEAD.

Prima di presentare il gate operativo: commit/tree esatti, CI verde, PASS del
revisore indipendente sul nuovo delta, piano di backup/copia cifrata/ripristino,
identità runtime fresca e rollback applicabile. Richiedere decisioni distinte:
merge; rilascio sola app; ricevuta registry e audit; raccordo dati SILVER;
installazione/configurazione/attivazione WordPress e consumer. Nessun cambio
schema o migrazione è richiesto da questo candidato.

Produzione di riferimento documentata R108: source
`b4349dbf829efae8994b81b06350a7fb292572cd`, tree
`4686679a6b1de9a18ba9b1be62af066d9f9354be`.
La differenza con main è prevista e comprende funzioni dormienti; non è una
prova di deploy arretrato. Il candidato non attiva marketing R13, canale Windows,
provider, state machine, dispatch, worker, scheduler o campagne pubblicitarie.

## Continuità e custodia

R42/R108 restano conclusi nelle ricevute originali. Gli addenda Governance
devono riportare gli esiti nuovi senza modificare gli stati storici M1–M5.
Il ripristino isolato R108 è attestato; la sola copia cifrata verificata non
dimostra decrittazione della copia esterna né disponibilità di restoreconfig.
Questi prerequisiti restano da attestare dal titolare della custodia, senza
aprire o trasferire materiale privato. I quattro residui R48 sono separati.
La migrazione MSI → nuovo PC è esclusa da PRELANCIO-01.
