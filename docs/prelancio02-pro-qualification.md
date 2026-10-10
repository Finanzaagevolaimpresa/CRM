# PRELANCIO02: profilo locale WPForms Pro

Il banco VNX03/N14 mantiene Lite 2.0.1.1 come profilo predefinito della CI.
Il profilo esplicito `VNX03_WPFORMS_EDITION=pro` riusa gli stessi test browser,
fixture, producer, consumer e controlli di presa in carico. Non attiva il sito.
Un risultato Lite, un controllo ZIP o un esito offline non qualificano Pro.

## Input vincolati

| Input | Identità del profilo Pro |
| --- | --- |
| Plugin | WPForms Pro 2.0.2.2, slug `wpforms` |
| ZIP locale | SHA256 `0e3fba8ed7388c816790ff5580984cdf599b638d92d64f6ffd5ffc2a1b200db2`, 14.339.342 byte |
| WordPress | 7.1.3, immagine ufficiale `wordpress:7.1.3-php8.4-apache` |
| Manifest Linux amd64 | `sha256:c74a0947d65b4cf20071d4324e2ac6a80db015451934716ad61f93fe471122ce` |
| Config dell'immagine | `sha256:0264543ee10f11253529ac109a8fb50a6f0a989994ad2f7a8529aa5dff4dbea7` |
| PHP | 8.4.26, da verificare anche nel container effettivo |
| Schema | `candidate-schema49`; prefissi e migrazioni invariati |

Il pacchetto è stato scaricato dall'account ufficiale e fornito localmente dal
proprietario. Il digest fissa i byte osservati; non è una firma del produttore.
Il manifest e la config sono stati letti dal registry ufficiale, senza pull o
avvio. La qualifica runtime del profilo Pro resta da eseguire.

Lo ZIP, le licenze, gli account e le configurazioni private non entrano in Git
o negli artifact pubblici della CI. Il file locale passa a BuildKit tramite
`tests/vnx03/docker-compose.pro.yml`. Il Dockerfile ne verifica nuovamente il
digest; non scarica Pro da URL autenticati. L'immagine di prova risultante
contiene il plugin e rimane locale al banco, senza push a registry.

Il trasporto usa 32 parti locali da massimo 500 KiB, ricomposte nell'ordine fissato
nel Dockerfile e verificate con il digest dell'intero ZIP. Il runner crea una
sola directory nuova nel proprio temporaneo esterno al checkout, verifica i byte
prima e dopo la suddivisione, rifiuta file aggiuntivi, collegamenti e destinazioni
già presenti. Ogni parte è un secret BuildKit; Lite non fornisce questi input e
mantiene il download pubblico. La topologia runtime non cambia.

Il tentativo R03 è terminato prima dei test perché lo ZIP di 14 MB supera il
[limite 500 KiB per secret BuildKit](https://github.com/moby/buildkit/blob/v0.32.2/session/secrets/secretsprovider/store.go).
La suddivisione rispetta quel limite e il divieto esistente di contesti Docker
aggiuntivi. Il plugin rimane nell'immagine/cache locale come già previsto;
nessuna credenziale, licenza o file adiacente viene trasferito. Il cleanup include
le sole parti temporanee. Il numero 32 limita l'archivio ammesso a 16.384.000 byte;
il profilo continua a richiedere l'esatto ZIP Pro di 14.339.342 byte.

## Preflight e autorità

Il comando resta `bash scripts/vnx03/run-e2e.sh`, con l'opzione esistente
`--preflight-only` per i soli controlli preliminari. L'esecuzione completa deve
avere la specifica autorità richiesta dalle istruzioni applicabili: il flag
`VNX03_SYNTHETIC_E2E_CONFIRMED=1` esprime una precondizione tecnica, non un consenso.
Non riutilizzare grant Q1 o autorizzazioni di precedenti rilasci.

Il profilo Pro richiede inoltre queste variabili nel solo processo di prova:

- `VNX03_PRO_PACKAGE`: percorso dell'archivio locale esatto, fuori dal checkout;
- `VNX03_PRO_PYTHON`: eseguibile Python approvato, usato per l'ammissione offline;
- `VNX03_EXPECTED_DOCKER_ENGINE_ID` e `VNX03_EXPECTED_DOCKER_CONTEXT`: valori del
  target locale già verificato, indicati nel piano esecutivo privato;
- `VNX03_QUALIFICATION_PROFILE=candidate-schema49`,
  `VNX03_EXPECTED_SOURCE_COMMIT` e `VNX03_EXPECTED_SOURCE_TREE`: candidato pulito;
- `VNX03_EVIDENCE_DIR`: directory nuova per le ricevute, fuori dal checkout.

`DOCKER_HOST` non è ammesso nel profilo Pro. L'endpoint deve essere locale e
contesto/Engine devono coincidere. Il pipe `dockerDesktopLinuxEngine` è ammesso
soltanto per Pro con questi binding. La selezione Buildx è distinta dal contesto:
il profilo rifiuta `BUILDX_BUILDER`, `BUILDKIT_HOST`, `DOCKER_BUILDKIT`,
`COMPOSE_DOCKER_CLI_BUILD` e `COMPOSE_BAKE` valorizzati. Ispeziona senza bootstrap
il builder nominato dal contesto, ammette soltanto un nodo `running` con driver
`docker` ed endpoint uguale al contesto verificato, quindi passa esplicitamente
`--builder` alla build. Un diverso builder predefinito persistente non è usato.
Le chiamate successive conservano il medesimo `DOCKER_CONTEXT` nel solo processo.
Il [driver docker](https://docs.docker.com/build/builders/drivers/docker/) è
integrato nell'Engine.

Per Pro, `compose build --print --pull` rende la definizione equivalente dei tre
target. Il banco verifica contesti e Dockerfile locali, commit/tree, argomenti,
digest, unico input Pro, etichette e tag esclusivi, output `type=docker` e assenza
di opzioni ulteriori. Passa poi quel JSON inalterato a
`docker --context <verificato> buildx bake --builder <verificato>`, concedendo
lettura soltanto al checkout e alla directory delle sole parti del ZIP già ammesso.
Nessun push o builder nuovo.
La via Lite resta invariata. Errori di renderizzazione o identità fermano prima
di Buildx; un errore di build non avvia retry o percorsi alternativi.

Questo raccordo evita il processo Buildx standalone di
[Compose 5.5.1](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/shellout.go),
che propaga insieme `DOCKER_CONTEXT` e `DOCKER_HOST`. Nella
[CLI 29.7.2](https://github.com/docker/cli/blob/v29.7.2/cli/command/cli.go)
il secondo può selezionare `default` in assenza del flag globale esplicito.
Il primo banco Pro si è fermato durante tale selezione, prima dei test funzionali;
cleanup verificato. La correzione del trasporto non vale come qualifica Pro.

Le risorse del progetto devono essere assenti prima della prima creazione.
Oltre alle etichette, sono confrontati i nomi effettivi del modello Compose con
l'inventario completo di volumi, reti e container: anche un volume omonimo senza
etichette o con etichette estranee ferma il banco. Nomi esterni al progetto,
risorse external, collisioni o inventari incerti fermano prima dell'abilitazione
del cleanup, senza rimuovere risorse pregresse. Git Bash converte solo i percorsi
host; i percorsi del container non vengono riscritti da MSYS.

## Perimetro di prova e recupero

Topologia e matrice di accettazione esistenti restano invariate. Il profilo
aggiunge soltanto un input di build, senza nuovi servizi, volumi o porte.
Applicazioni sulla rete interna; ingressi browser solo loopback; WordPress cron
e HTTP esterno disabilitati; notifiche delle fixture disabilitate. Account,
documenti, database e chiavi sono esclusivamente sintetici. Nessuna copia live.

Il banco verifica invio reale dal browser, ricevuta/proiezione/provenienza,
consensi separati, replay, richieste distinte, dinieghi e recupero; quindi
assegnazione, accettazione personale e prossima azione datata nel CRM sintetico.
I confronti versione includono Pro, WordPress, PHP e connector 1.2.1.

Il trap esistente rimuove soltanto il progetto nuovo (container, volumi, reti e
tre immagini di test) e verifica l'assenza. Nessun prune o cleanup globale.
Le ricevute persistono fuori dalla directory temporanea. Un cleanup incompleto
è un esito negativo da riconciliare, senza un nuovo run automatico. La qualifica
non è un rollback produttivo né autorizza installazione, chiavi o attivazione.

## Verifiche preparatorie

`tests/vnx03-pro-package-offline.test.py` controlla byte sintetici, strutture ZIP,
identità dichiarata e rifiuti, senza estrarre o eseguire PHP.
`tests/vnx03-pro-profile-offline.test.py` controlla la selezione e i rifiuti del
profilo mediante Bash/Python, senza Docker, DB, PHP o rete.
`tests/vnx03-pro-docker-admission-offline.test.py` esercita le ammissioni reali
Bash/Python con Docker interamente sostituito: override, builder remoto/ambiguo,
inventari falliti e nomi occupati non possono trasferire input o invocare cleanup.
I test del trasporto sostituiscono anche la build: controllano propagazione del
contesto, input inalterato, percorsi con spazi, dinieghi e nessun retry implicito.
Il job N14 li esegue prima della qualifica Lite già esistente. La prova Pro deve produrre le proprie
ricevute `runtime.json`, `n14-runtime.json`, browser e cleanup sul target esatto.

`tests/vnx03-pro-build-context-offline.test.py` verifica ricomposizione esatta oltre 500 KiB,
file adiacenti esclusi, digest errato, destinazione occupata, collegamenti e input
modificati prima del trasporto. In CI `tests/vnx03-pro-build-context-ci.sh` genera
un archivio di oltre 15 MiB, costruisce con Compose/Bake e il Dockerfile effettivo,
poi rimuove solo le tre immagini del progetto esclusivo. Non usa il pacchetto
commerciale, non avvia WordPress o DB e non sostituisce il collaudo funzionale Pro.
La ricevuta distinta `pro-build-transport.json` espone questi limiti e la pulizia.

Il tentativo locale R04 ha verificato la ricomposizione del vero ZIP Pro e la
build, poi si è fermato su `init-materials.sh`: il checkout Windows aveva
convertito gli LF del blob Git in CRLF, invalidando `set -Eeuo pipefail` in
Linux. Nessun test funzionale Pro è stato eseguito; cleanup verificato.
Anche l'entrypoint WordPress viene copiato dal checkout nell'immagine.
Gli attributi `text eol=lf` sono quindi limitati agli script shell del banco
VNX03, compresa la prova CI del trasporto. Non cambiano la configurazione Git
globale né il contenuto canonico degli script, già LF nei blob.
`tests/vnx03-shell-checkout-offline.test.py` usa i veri filtri Git con
`core.autocrlf=true` limitato al comando, confronta i byte del checkout e verifica
la sintassi di tutti gli script del banco. Per i due entrypoint esegue soltanto
le prime due righe, preventivamente confrontate con una lista consentita:
l'header LF passa, quello CRLF riproduce l'errore nella CI Linux. Il solo controllo
negativo è esplicitamente saltato su Windows, dove Git Bash accetta CRLF;
i confronti dei byte e dei filtri Git restano obbligatori anche sull'MSI.
Un percorso di controllo esterno al banco conserva la conversione Windows. Nessun Docker, DB o corpo
degli script viene eseguito; questo controllo non qualifica Pro.

Nel tentativo locale R05 gli script LF hanno superato l'inizializzazione dei
materiali TLS. Il banco si è fermato durante la migrazione 43, prima delle prove
funzionali Pro; cleanup verificato. Il log Prisma conserva l'errore di transazione
abortita, non la prima eccezione PostgreSQL. Il confronto offline dimostra un
ulteriore disallineamento: i 49 file SQL copiati nell'immagine dal checkout Windows
avevano CRLF. Il digest del file della migrazione 42 nel checkout era diverso
da quello dei byte canonici richiesto dai due controlli della migrazione 43. Questa
evidenza non sostituisce un nuovo collaudo runtime.

Anche `prisma/migrations/*/migration.sql` conserva ora gli LF tramite attributi
Git: nessuna migrazione aggiunta o riscritta, nessun checksum storico aggiornato
e nessun controllo rimosso. Lo stesso test offline già eseguito dal job N14
confronta i veri filtri Windows e gli input SQL di build con tutti i blob Git;
verifica il digest richiesto dai controlli esistenti e rifiuta il corrispondente
input CRLF di controllo. Non esegue SQL o Prisma. La prova negativa passa anche
su Windows e resta distinta dallo SKIP locale del solo header Bash CRLF.

Il job fissa Compose 5.5.1 tramite l'azione ufficiale Docker vincolata a commit,
per confrontare lo stesso modello del banco MSI. Il renderer 2.38.2 del runner
produce opzioni di output ed etichette diverse: quel modello resta rifiutato,
senza allentare l'ammissione o cambiare Docker sull'MSI. In caso di arresto il
modello sintetico effettivamente generato viene conservato nell'artifact CI.

Il tentativo Pro R07 ha superato installazione, migrazioni e avvio del browser,
poi si e fermato su `after_granted_admission`: l'asserzione dell'identita sorgente
ammetteva soltanto `WPFORM:900001:EPHEMERAL:<32 hex>`, il caso senza entry persistita.
Il contratto PHP esistente produce invece `WPFORM:900001:ENTRY:<intero positivo>`
quando WPForms fornisce un entry ID. Il valore concreto dell'invio R07 non e
stato conservato nel log minimizzato: non viene ricostruito retroattivamente.
Il collaudo Pro e rimasto incompleto e il cleanup e verificato.

Il browser ora passa esplicitamente l'edizione selezionata a ogni asserzione DB
e richiede la stessa edizione nella risposta. Il controllo delle identita e
separato per profilo: Lite conserva il predicato EPHEMERAL; Pro richiede ENTRY
con intero positivo canonico, senza accettare l'alternativa Lite. Edizione assente
o sconosciuta, altro form e identificativi malformati restano bloccanti.
I controlli di conteggio, envelope canonico, provenienza, hash/idempotenza,
privacy, proiezione e replay non cambiano. Non cambia il connector o il CRM.
Le regressioni offline usano anche l'identita ENTRY della fixture PHP esistente;
non sostituiscono la nuova esecuzione completa Pro da autorizzare separatamente.

Il tentativo Pro R08 ha superato la prima sequenza browser (10 invii autentici,
errori di cattura, ripresa, consensi e proiezioni). Si e poi fermato al login del
primo commerciale sintetico N14; cleanup verificato. Una riproduzione locale su
pagina vuota dimostra che OpenSSL nativo Windows emette CRLF: il precedente
`tr -d '\n'` lasciava CR nella password, bcrypt lo includeva e l'input password
del browser lo rimuoveva. La credenziale originale R08 non e stata conservata:
la riproduzione identifica un difetto reale, non ricostruisce quel valore.

Il generatore comune normalizza esclusivamente CR/LF del materiale effimero,
controlla formato e lunghezza e conserva gli stessi byte casuali richiesti.
Un errore OpenSSL resta bloccante, senza essere mascherato da `export`.
Provisioning e browser rifiutano inoltre password con CR/LF prima di usare DB
o pagina. Non si normalizzano password di utenti reali e il login CRM non cambia.
La regressione offline esegue il generatore e tutte le 15 esportazioni reali con
OpenSSL sostituito (LF, CRLF, wrapping, errore e output invalido); nessun Docker,
DB o rete. Il job N14 la esegue prima della qualifica candidato esistente.

R08 conserva anche un distinto STOP del driver locale per un collegamento
transitorio alla rete Docker predefinita durante la build. ID e configurazione
non risultano cambiati; l'attore non e attribuito dalle prove acquisite. Questo
delta non modifica quella guardia, non converte R08 in PASS e non autorizza un
nuovo collaudo Pro o una nuova attivazione reale.
