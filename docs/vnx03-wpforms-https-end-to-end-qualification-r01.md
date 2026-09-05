# VNX-03 — WPForms HTTPS end-to-end qualification R01

## Scopo e confine

VNX-03 qualifica, senza installazioni operative, il percorso browser → WPForms Lite → connettore
VNX-02 → HTTPS verificato → N12 → N11 → consumer bounded VNX-01 → proiezione N13. Il test usa
soltanto dati, credenziali, chiavi, certificati, database e risorse Docker sintetici e ricreati da
zero. N14, worker AI, dispatch, agenti, provider esterni e writer legacy restano disabilitati.

La qualificazione vale per le versioni e i digest qui fissati. Non certifica WPForms Pro, un sito
WordPress reale, la configurazione operativa del CRM o un deploy.

## Provenienza immutabile

Verifica di provenienza eseguita il 5 settembre 2026 sulle distribuzioni ufficiali. Lo script
`scripts/vnx03/run-e2e.sh` riscarica gli artefatti, verifica i digest prima della build e fallisce in
caso di differenza.

| Componente | Versione o riferimento | Digest SHA-256 / integrità |
| --- | --- | --- |
| WPForms Lite | `2.0.1.1`, `downloads.wordpress.org` | `6245074790df01a6e24a42587e024132b4a28fac499d1a8fa12ebf5580e4852b` |
| WP-CLI | `2.12.0`, release ufficiale GitHub | `ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c` |
| WordPress / PHP | `wordpress:7.1-php8.4-apache` | `sha256:b8f37de278183840a09f5a4b5bf5ec9f09177a9984d2fe5cc072b4388128bd9d` |
| Node | `node:22-bookworm-slim` | `sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5` |
| PostgreSQL | `postgres:16-alpine` | `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` |
| MySQL | `mysql:8.4` | `sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb` |
| Playwright | `@playwright/test` `1.63.0` | npm integrity `sha512-oxMK4vllB9RK5NQ2l1pq1IfOf2AvnEuj/vYGDj0H2nMtmtZpKtCwt/l00GEO6xjGfpBNAvjovvYdCm50dRQkpQ==` |

Il digest dello ZIP del connettore è calcolato dopo il packaging dall'HEAD esatto e registrato in
`runtime.json`. La build copia esclusivamente il checkout Git del job; le immagini custom riportano
commit, tree e classificazione `VNX-03-SYNTHETIC` nelle label OCI. Versioni runtime di browser,
WordPress, WPForms, connettore, PHP, database, Node, Docker e Compose sono raccolte negli artefatti
sanitizzati della CI.

## Isolamento

Ogni esecuzione crea un progetto Compose univoco `fai-vnx03-*`, una rete `internal: true` e volumi
nuovi con la label `VNX-03-SYNTHETIC`. I database ammessi sono soltanto
`fai_vnx03_e2e` e `fai_vnx03_wordpress`; il database PostgreSQL riceve il commento sentinella
`FAI_CRM_VNX03_EPHEMERAL_TEST_ONLY_V1` prima delle fixture applicative.

L'unica porta pubblicata è WordPress HTTP su `127.0.0.1`, necessaria al browser del runner. CRM,
gateway TLS, PostgreSQL e MySQL non pubblicano porte. Nessun container è privilegiato e nessun
socket Docker è montato. Il codice sotto test entra nelle immagini durante la build; non è montato
in scrittura. Una CA privata effimera viene aggiunta soltanto al trust store del container
WordPress. cURL conserva `CURLOPT_SSL_VERIFYPEER=true`, `CURLOPT_SSL_VERIFYHOST=2`, protocollo solo
HTTPS e nessun redirect.

Il preflight registra contesto Docker locale, progetto, rete, database ed endpoint prima delle
scritture applicative. Il cleanup usa il nome progetto appena creato e rimuove soltanto i relativi
container, rete, volumi e tre tag immagine custom univoci; non enumera né modifica immagini base o
risorse preesistenti. Le cache effimere del runner terminano con il job.

## Percorso e controlli

WPForms Lite viene installato dallo ZIP verificato e crea due form tramite la propria API. Playwright
compila i campi renderizzati e preme il vero pulsante di submit. Il percorso positivo non richiama
manualmente `wpforms_process_complete`: l'hook è emesso dal plugin dopo la normale elaborazione del
form. Il connettore cifra e accoda localmente prima della conferma; l'invio avviene soltanto tramite
il vero evento cron WordPress, invocato in modo finito dal test.

La matrice obbligatoria comprende:

- configurazione disabilitata, form escluso e consenso di servizio assente: nessuna riga di coda e
  nessuna ammissione CRM;
- gateway arrestato: conferma browser entro il timeout, envelope cifrato preservato, retry reale e
  consegna dopo il ripristino;
- disattivazione e riattivazione reali del plugin: evento cron rimosso, coda invariata e
  rischedulazione dall'hook di attivazione WordPress;
- percorso positivo con marketing accordato: una ricevuta N12/N11, una sola proiezione N13 e due
  evidenze privacy coerenti;
- risposta 202 persa dopo il commit N11: stesso envelope e idempotency, ritrasmissione con nuova
  impronta di richiesta, stessa ricevuta e nessun secondo evento o Lead;
- percorso positivo con marketing negato: secondo e unico Lead con decisione `DENIED` e relativa
  evidenza;
- HMAC non valido, hostname errato e CA non attendibile: rifiuto, nessuna nuova ammissione N11 e
  nessuna nuova proiezione;
- contenuto della coda sempre cifrato finché pendente; assenza dei marker sintetici in chiaro;
- 43 migrazioni completate, schema e migrazioni invariati, writer legacy e N14 senza effetti.

Le attese seguono il backoff reale esistente e restano bounded. Il proxy TLS del solo harness può
arrestarsi o perdere una risposta già ammessa; non sostituisce N12, N11, il consumer VNX-01 o il
proiettore N13 nel percorso positivo.

## CI e ripetibilità

Il job obbligatorio `VNX-03 authentic WPForms HTTPS end-to-end`:

1. verifica HEAD, 43 migrazioni e assenza di delta su runtime CRM, Prisma e configurazioni di
   produzione;
2. dimostra che lo script fallisce senza la sentinella sintetica e che Docker è locale/Linux;
3. installa le dipendenze dal lockfile e Chromium tramite Playwright `1.63.0`;
4. costruisce e avvia l'ambiente isolato, applica le 43 migrazioni esistenti e installa WordPress,
   WPForms e lo ZIP del connettore prodotto dall'HEAD;
5. esegue l'unico test browser seriale senza skip;
6. carica soltanto evidenze minimizzate e prive di chiavi, header HMAC o payload, quindi distrugge
   le risorse VNX-03.

Comando equivalente su un host Linux con Docker locale:

```bash
VNX03_SYNTHETIC_E2E_CONFIRMED=1 \
VNX03_BASE_SHA="$(git merge-base HEAD origin/main)" \
npm run test:vnx03:e2e
```

L'esito qualificante è il job verde sull'HEAD della PR e, dopo il merge, sul commit di `main`.
Un fallimento di download, digest, build, prerequisito, browser, assertion, cleanup o upload delle
evidenze rende il gate rosso; non esistono percorsi di skip o `continue-on-error`.

## Impatto e rollback

Le modifiche sono limitate a harness, fixture, test, workflow CI, dipendenza browser di test e questo
dossier tecnico. Runtime CRM N11/N12/N13, schema Prisma, 43 migrazioni e configurazioni distribuite
restano invariati. Prima del merge il rollback è il revert della PR; dopo il merge è una nuova PR che
rimuove job, harness e dipendenza di test. Non è previsto alcun rollback dati o applicativo reale.
