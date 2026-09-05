# VNX-02 — Recupero CI audit PostgreSQL R01

## Ripresa del 5 settembre 2026: causa riprodotta e correzione del solo test

La preparazione del runner è stata autorizzata dal supplemento
`FAI_CRM_VNX02_RUNNER_PROVISIONING_AND_CI_RECOVERY_MANDATE_R01`. Il precedente
rapporto di STOP è conservato integralmente nella sezione storica sotto.
Questa evidenza tecnica non riproduce i mandati o il dossier privato F02 e non
introduce autorizzazioni a merge, deploy o attivazione.

Baseline riconfermata: branch `codex/vnx02-wordpress-secure-lead-connector`,
HEAD `365b2037d074c9c8959f7014d95065fc9da57db9`, base/main
`18c8bf252cca9d6f1ff369e3d4f69149ef462f69`, PR #115 OPEN/Draft. L'evidenza
locale precedente era l'unico file untracked in questo perimetro e aveva
SHA-256 `37af186ce805d275d174a4706ec14d7df288968d29b54fe331667740b89ef92d`.
Nessuna modifica preesistente è stata scartata. Governance, produzione e
WordPress reale non sono stati contattati.

### Runner e approvvigionamento

Contesto Docker locale `desktop-linux`, endpoint named pipe già verificato;
nessun registry mirror configurato. Base richiesta: `node:22-bookworm`, della
[distribuzione ufficiale Node](https://github.com/nodejs/docker-node/blob/main/README.md).
I domini di autenticazione, registry e CDN del pull sono documentati dalla
[allowlist ufficiale Docker](https://docs.docker.com/desktop/setup/allow-list/).
Nessuna immagine è stata pubblicata.

| Identità | Valore |
| --- | --- |
| Index della base Node | `sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d` |
| Base fissata, `linux/amd64` | `node@sha256:87a4f951f28b85d189df365d24c479d3bdb70be77c1ff5c9029db2ef67e251ac` |
| Provenienza Dockerfile ufficiale | `nodejs/docker-node`, revisione `bc0a422bce0f729dd85790639d9f1918143f1235`, `22/bookworm` |
| Runner locale canonico | `vnx02-20260905-runner-5503d2ff:qualified-lf` |
| ID immagine runner | `sha256:a805f95044caafa9eb5a879979baa51bead7630c0190fb6ca3131cacfc7cf72c` |
| Config digest runner | `sha256:248bc62b7ef87edbbabe8e5f9546e58b87a686923cff6c3df6d1d80339a94afe` |
| Piattaforma | `linux/amd64`, Prisma `debian-openssl-3.0.x` |
| Versioni effettive | Node `22.23.2`, npm `11.16.0`, tsx `4.22.4`, Prisma/Client `5.22.0` |
| Commit motori Prisma | `605197351a3c8bdd595af2d2a9bc3025bca48ea2` |

Il contesto fuori repository contiene soltanto `package.json`,
`package-lock.json`, `prisma/schema.prisma` e `Dockerfile`. L'estrazione canonica
usa `git -c core.autocrlf=false archive`; gli hash sono stati confrontati con i
blob originali dell'HEAD, senza passaggio da `node_modules` Windows.

| Input canonico | SHA-256 |
| --- | --- |
| `package.json` | `ebb92c0f18e91976ae57084fc63fd928c2584089a6615dc158ead0608d5afe17` |
| `package-lock.json` | `2f9f86ee9293322007e33a2f6cb8a69b348cf3d1159fb9c6941cf28dcf769b2f` |
| `prisma/schema.prisma` | `729ac5d6691c61df8cb0c16db07dd720f69b9a6da49957e8093e307fd89862ec` |
| Ricetta Dockerfile | `b7f456a560bacf2a2136613b4e7ab999cdcad7b8dbef1a722f210f983248f68a` |
| Archivio di esecuzione HEAD | `eac5c9c885a0310eaa10da281aac71d1c8afc886626ca468ab0a9aeaef766d60` |

Tutti i 483 record del lockfile hanno URL `registry.npmjs.org` e integrità
SHA-512. `npm ci --ignore-scripts --include=dev --no-audit --no-fund` installa
403 pacchetti applicabili a Linux; versioni, URL e integrità del lock installato
sono stati confrontati con il lock sorgente. `npm cache verify`: 396 contenuti,
187.228.153 byte, verificati. npm 11.16.0 è installato separatamente per
allineamento alla CI, sempre dal registry autorizzato e senza lifecycle script.

Gli script pertinenti sono stati esaminati: `@prisma/engines`, `@prisma/client`,
`prisma`, `esbuild`, `unrs-resolver`; `fsevents` non è applicabile a Linux.
Esbuild e il binding del resolver funzionano con i pacchetti nativi del lock,
senza eseguire i rispettivi installer. Il downloader Prisma del pacchetto
installato identifica `https://binaries.prisma.sh`: è stato invocato
esplicitamente per query library e schema engine della versione sopra, con
`failSilent=false` e senza esenzioni dai checksum. Generazione Prisma e prova
del client sono avvenute in uno stadio `--network=none`; telemetry/update check
sono disabilitati, nessun database reale è configurato.

SHA-256 motori: schema engine
`cedeae04739cfa085493da2bafb5d1e4da0247fc74f2995a51ee24f20c9890be`;
query library
`35860a5c0fb2f79e7b38c40747c4d212318d97e1910ca528b133c802716de0b8`.
Qualifica: codice TypeScript tipizzato eseguito da tsx; esbuild trasformante;
binding resolver caricato; client/engine realmente eseguito contro endpoint
sintetico assente con `P1001` atteso e rete `none`; successivo `SELECT` Prisma
riuscito sul nuovo PostgreSQL con guard e sentinel validati.

### Isolamento e riproduzione deterministica

Rete nuova `vnx02-20260905-audit-5503d2ff-net`, `Internal=true`, label
`org.fai.vnx02.session=vnx02-20260905-runner-5503d2ff`. PostgreSQL usa il digest
locale già presente `287eced1f33b59ed265ed13a60d3680dd7646d70c4dc0e785f59a470ebc03eeb`.
Ogni round ha PostgreSQL e runner nuovi; il runner condivide soltanto il
namespace di rete del proprio PostgreSQL, così il guard conserva l'URL
loopback senza pubblicazione di porte. Rootfs read-only, nessun privilegio,
`cap-drop=ALL`, `no-new-privileges`; repository bind `RW=false`. Scritture di
esecuzione e database soltanto in tmpfs. Nessuna route di default nel namespace.

Prima di avviare PostgreSQL sono stati verificati rete interna, mount, utente,
assenza di porte/privilegi e proprietà effimere. Database `fai_crm_test`, schema
`public`, utenza/credenziali sintetiche; commento DB-bound
`FAI_CRM_EPHEMERAL_TEST_ONLY_V1` verificato dal guard originale tramite Prisma.
Ogni round canonico applica esattamente le 43 migrazioni e il seed idempotente
due volte. Nessun database di diagnosi è collegato alla rete di preparazione.

Prima delle esecuzioni sono state fissate **tre ripetizioni**, ciascuna su un
database nuovo. Il probe chiama il servizio TypeScript reale, porta il globale
da genesis v1 a v2 e invia quattro richieste stale. Risultato identico in tutti
i round:

| UUID sintetico | `requestId` persistito | Eventi fisici nuovi | Query originale | Correlazione hash |
| --- | --- | ---: | ---: | ---: |
| `abcdefab-cdef-4abc-8def-abcdeabcdefa` | invariato | 1 | 1 | 1 |
| `01234567-abcd-4abc-8def-abcdefabcdef` | `[REDACTED:PERSONAL]-abcd-4abc-8def-abcdefabcdef` | 1 | 0 | 1 |
| `07654321-abcd-4abc-8def-abcdefabcdef` | `[REDACTED:PERSONAL]-abcd-4abc-8def-abcdefabcdef` | 1 | 0 | 1 |
| `abcdefab-0123-4567-8901-abcdefabcdef` | `abcdefab-[REDACTED:PERSONAL]-abcdefabcdef` | 1 | 0 | 1 |

Per ogni caso sono verificati evento `ai_orchestrator_control_cas_conflict`,
attore sintetico esatto, tipo/target `AiOrchestratorAdminPolicyRevision` /
`GLOBAL:global`, esito `CAS_MISMATCH`, versioni 1/2, nessuna revisione stale
aggiunta. Il delta fisico usa tutti gli ID audit prima/dopo, senza filtrare per
UUID o hash. L'oracolo ricostruisce l'identità del comando in SQL usando la
canonicalizzazione PostgreSQL, indipendente dal builder TypeScript e da N04.

I due UUID che collassano sulla stessa stringa redatta hanno hash diversi,
conservati integralmente. L'audit rimane quindi correlabile con l'identità
tecnica esistente: non è stato necessario cambiare il contratto o la redazione.
Il difetto riprodotto è l'uso, nel test, di un campo redigibile come selettore
round-trip. L'UUID e le righe del database del run CI storico non sono presenti
nel log: non si dichiara di aver recuperato o interrogato quell'evento. È invece
dimostrato lo stesso sintomo, nel medesimo percorso applicativo, per fixture
valide e ripetibili senza perdita dell'audit.

### Correzione e controlli

Solo `tests/db/ai-orchestrator-admin-control-plane-db.test.ts` è modificato
oltre a questo documento. La query usa hash di comandi calcolati prima della
mutazione con l'oracolo SQL, mai hash estratti dall'audit. La cardinalità
originaria è mantenuta, inclusi replay senza duplicazione e collisione con due
eventi distinti. Il delta fisico non filtrato impedisce che un evento aggiuntivo
con hash errato sfugga al controllo. Attore, evento, target, operazione,
scope/esito/versione sono verificati separatamente.

Il caso di successo usa deliberatamente un UUID interferente. Restano anche
UUID casuali; le regressioni aggiungono controllo e tre forme numeriche con
valori redatti letterali e hash golden. Non viene chiamato il redattore per
costruire l'atteso. I controlli negativi verificano che l'oracolo rifiuti
assenza, duplicati, altra richiesta, attore, tipo/target, evento o esito errati.
La prova del rifiuto pre-validazione richiede ora specificamente `ZodError`,
così un errore delle nuove asserzioni non può essere scambiato per il rifiuto
atteso. Le race continuano a usare l'API concorrente originale.

Risultati già acquisiti: 3 × 4 probe PASS; test mirato 14/14, zero skip;
typecheck e lint PASS; 19 file PHP senza errori di sintassi; 11 contratti PHP e
10 scenari scheduling/F01 PASS. Suite completa e CI finale sono riportate nella
sezione di chiusura, quando concluse; nessun risultato storico viene contato
come esecuzione nuova.

### Incidenti di allestimento conservati nelle evidenze

- Il primo controllo PowerShell ha interpretato erroneamente una mappa JSON
  vuota/una collezione a elemento singolo. Nessun container era stato avviato;
  la deserializzazione è stata corretta, non le condizioni del guard.
- `git archive` con `core.autocrlf=true` aveva convertito gli input a CRLF.
  Migration 43 ha correttamente rifiutato l'hash della copia di migration 42
  (`24cf18...` invece del blob canonico `fc94e1...`). Quel database è stato
  rimosso; nuova estrazione byte-identica e nuovo runner hanno superato tutte
  le 43 migrazioni, senza modificare SQL o storico Git.
- Un errore di quotatura degli argomenti comma-separated in una funzione
  PowerShell ha fatto tentare al Docker CLI la risoluzione di `nosuid:latest`.
  Il registry l'ha negata; nessun layer scaricato, nessun container creato da
  quel comando. È un tentativo involontario fuori dalla selezione di immagini
  prevista, registrato come tale. Argomenti corretti e `--pull=never` imposto
  negli avvii di diagnosi; nessuna nuova fonte è stata aggiunta.
- Per la suite storica servono dipendenze fisiche nello spazio effimero e un
  parent scrivibile. Il tmpfs di esecuzione della sola sessione è stato reso
  esplicitamente `exec` per i binari Linux verificati; `nosuid`, `nodev`,
  rootfs/repository read-only e utente non-root restano invariati. Un tentativo
  `docker cp` in stallo senza file creati è stato interrotto; lo stesso pack è
  importato con `git index-pack` da stdin. Nessun mount Git host aggiuntivo.
- La prima suite completa locale ha dato 226/228: modalità sessione mancante
  e startup PR90 non healthy. Gli input sintetici dell'ambiente sono stati
  riallineati a quelli già presenti in CI; nessun test/timeout/controllo è
  modificato per questi esiti. La prima suite unitaria dava 519 PASS e uno skip
  PHP: si usa la fixture prodotta dal PHP reale tramite il meccanismo offline
  già previsto dal test, senza modificarlo.

### Chiusura delle prove locali e pulizia

Esecuzioni conclusive del 5 settembre 2026, prima del commit di recupero:

| Controllo | Esito nuovo |
| --- | --- |
| Probe deterministico, tre database nuovi × quattro UUID | 12/12 PASS |
| File PostgreSQL mirato | 14/14 PASS, zero skip |
| Suite unitaria completa, fixture prodotta dal PHP reale | 520/520 PASS, zero skip |
| Suite PostgreSQL completa, ambiente sintetico allineato alla CI | 228/228 PASS, zero skip; tutti i 226 originali più due regressioni |
| Typecheck e lint | PASS |
| PHP: sintassi / contratti / scheduling F01 | 19 file / 11 test / 10 test PASS |
| Guard build context | PASS: 407 file tracked, un Dockerfile, 11 sorgenti di contesto esplicite |
| Build ottimizzata Next.js | PASS; warning preesistenti di middleware e tracing, non modificati |
| Packaging WordPress | PASS, 14 entry; SHA-256 `a612b3eeeceec1cbdf27acb9f0c1377b951d45ad976cdf8a8e75750708b78140` |
| Prisma / runtime CRM | 43 migrazioni; nessun delta rispetto alla base |

Il contenuto del test eseguito ha SHA-256
`a78341add474e65a1ae8a4767acb7f5c8939aba58bb2dd66ebfad5fc4b83136f`.
PHP è eseguito con l'immagine locale
`wordpress@sha256:77bb03bd978b0654e38446b1c98400f8a0e187654e72cead120ea5e30f50d741`,
rete `none`, rootfs/repository read-only e utente non-root. Il pacchetto coincide
con quello F01 già documentato: questa correzione non cambia il plugin.

Le coppie effimere sotto il prefisso `vnx02-20260905-audit-5503d2ff-`
(`pg`/`run`, `probe1-pg`/`probe1-run`, `probe2-pg`/`probe2-run`,
`probe3-pg`/`probe3-run`, `suite-pg`/`suite-run`) sono state rimosse, comprese
le istanze di allestimento scartate. Rimossa la rete
`vnx02-20260905-audit-5503d2ff-net`, ID
`766ebf17be2f09df14379a95c25f5ff1431d34dbba733ccc408cf8361a6953d9`.
Le qualifiche e prove PHP usano nomi nuovi sotto il prefisso della sessione e
rimozione automatica. Verifica finale per label: zero container, zero reti,
zero volumi della sessione. Nessun volume dati era stato creato; tutti i dati
PostgreSQL e gli output di esecuzione erano in tmpfs e sono eliminati.

Rimossi gli input, gli archivi, il pack Git e i relativi indici, gli script di
diagnosi e il contesto di build dedicato fuori repository. Il suo unico file
rimasto è `runner-manifest.json` (5.175 byte), SHA-256
`99f058943f3eabf94b5a519736428ef2675f370edf4e5695faed196584ec8a9b`:
contiene provenienza, versioni, hash e ricetta, senza dati di fixture o fonti
private. Conservata l'immagine qualificata `:qualified-lf`; rimosse soltanto
le immagini intermedie etichettate della sessione `:dependencies` e
`:qualified` (prima candidata CRLF).

La policy della piattaforma ha rifiutato un comando di pulizia che comprendeva
anche il riferimento alla base Node, perché non dimostrava che quel riferimento
non fosse preesistente. Il comando è stato sostituito dalla sola pulizia
autorizzata di container/rete e immagini intermedie identificate; la rimozione
della base non è stata ritentata. La base Node resta locale, insieme al runner,
senza database o dati operativi. Nessun prune globale, nessuna modifica alle
immagini o alle risorse Docker preesistenti. Il container PostgreSQL storico
rimane arrestato, come nel preflight.

Il delta di recupero è limitato a questo documento e al singolo test autorizzato.
Workflow, lockfile, dipendenze, runtime, filtro N04, schema e migrazioni sono
invariati rispetto all'HEAD autorizzato. Le differenze del workflow già presenti
nella PR precedente non sono nuove modifiche di questo intervento.

### Gate di pubblicazione e ricontrollo

Questa sezione registra prove locali concluse, non anticipa il risultato della
CI. Dopo commit e push sullo stesso branch, l'HEAD esatto, il tree e il nuovo run
saranno identificati nella PR e nel rapporto di consegna. Restano obbligatori
audit di sicurezza, PHP/MySQL, build, smoke e restore/rollback sintetici della
CI, oltre alle suite sopra; Ready è consentito solo con i controlli applicabili
verdi. Nessuna riesecuzione casuale è autorizzata.

F01 resta soggetto a ricontrollo indipendente. Il dossier F02 integrale locale
è rimasto privato e invariato (SHA-256
`ba762e55bca31573a88a929bb338979e87288aa53f4ddccdb539e1a94c9f7076`).
Non è incluso in contesto, immagine, commit o PR. La sua disponibilità locale
non dimostra l'accessibilità per il Revisore: Antonio deve allegare il file
integrale nella chat prevista. Nessuna chiusura documentale o consegna al
Revisore è dedotta dalla sola presenza di questo documento tecnico.

`activation_authorized=NO`; nessun merge, deploy o inoltro automatico.

## Storico conservato: preflight 04:24–04:30 UTC

# VNX-02 — CI PostgreSQL audit recovery R01: evidenze di preflight e STOP

Rilevazione: 5 settembre 2026, 04:24–04:30 UTC.
Mandato di riferimento: `FAI_CRM_VNX02_CI_POSTGRESQL_AUDIT_RECOVERY_MANDATE_R01`.

## Esito

`STOP_RUNNER_OFFLINE_UNAVAILABLE`. Il preflight non ha individuato un'immagine
locale del runner Node.js/tsx/Prisma necessario per eseguire il percorso
applicativo e la suite PostgreSQL nell'isolamento autorizzato. PostgreSQL 16 è
disponibile; l'inventario completo delle immagini, incluse quelle intermedie e
senza tag, non contiene un runner applicativo qualificabile.

Nessun container è stato creato o avviato. Nessun pull, download, installazione,
scrittura database o nuova esecuzione CI è stato effettuato. L'ipotesi N04 non è
stata promossa a causa dimostrata del run fallito. La condizione necessaria per
modificare il test non è soddisfatta.

## Identità e istruzioni

| Elemento | Verifica |
| --- | --- |
| Repository | `Finanzaagevolaimpresa/CRM` |
| Worktree | `C:/Users/Utente/.codex/worktrees/4898/CRM` |
| Branch locale e remoto | `codex/vnx02-wordpress-secure-lead-connector` |
| HEAD locale e PR | `365b2037d074c9c8959f7014d95065fc9da57db9` |
| Tree HEAD | `97fb823d7b78806354d0625ae72dc3624dae0dcf` |
| Main remoto e base PR | `18c8bf252cca9d6f1ff369e3d4f69149ef462f69` |
| Relazione `origin/main...HEAD` | 0 commit solo su main, 3 solo sul branch |
| PR #115 | OPEN, Draft, non mergiata; `mergeStateStatus=UNSTABLE` |
| Worktree tracked | Pulito al preflight; nessuna modifica tracked introdotta |
| Operazioni Git in corso | Nessun marker merge, cherry-pick, revert, rebase o sequencer |
| Migrazioni tracked | 43, nessun delta Prisma rispetto alla base |

La baseline Governance indicata dal mandato non è stata ricontrollata:
Governance e produzione non sono state contattate né modificate.

Sono stati letti `$fai-crm-delivery` e il relativo contratto di instradamento R04
della versione locale `0.4.0+codex.20260904210114`. Il modello richiesto dal
mandato è GPT-6 Astra Max; questo documento non certifica l'identità del modello
in esecuzione e non ne modifica la configurazione.

Il file antenato `C:/Users/Utente/.codex/AGENTS.md` è stato letto integralmente:
la sua sezione di autonomia protetta dichiara applicazione esclusivamente al Git
root `C:/Users/Utente/Desktop/CRM`, diverso da questo worktree. Nessun altro
`AGENTS.md` è presente nei percorsi antenati verificati, nel root del worktree,
in `tests`, in `tests/db` o in `docs`; nessuno è tracked nel tree. Il mandato
corrente resta il limite operativo. Il file protetto `CRM TXT.txt` non è stato
letto, modificato o incluso in operazioni Git.

## Evidenza della CI esistente: nessun nuovo run

La [CI 33923885981, tentativo 2](https://github.com/Finanzaagevolaimpresa/CRM/actions/runs/33923885981/attempts/2)
è conclusa con `failure` sull'HEAD sopra indicato. Il log minimizzato conferma:

```text
not ok 23 - global mutation usa CAS, audit atomico, replay idempotente e collision detection
expected: 1
actual: 0
tests/db/ai-orchestrator-admin-control-plane-db.test.ts:604:10
tests 226
pass 225
fail 1
skipped 0
```

Il job ha superato lint, suite unitaria, controlli WordPress/PHP, packaging,
applicazione delle 43 migrazioni e sentinel. Typecheck, build, smoke e drill
restore/rollback successivi risultano **skipped**, non verdi sull'HEAD attuale.
I risultati storici non sono stati riscritti né sostituiti da questo documento.

Il blob del test è ancora `0e072aadd09b8961ddc3a3ba1befa256760abb77`.
Il confronto con la base non mostra delta in `src`, `tests/db` o `prisma`.
`package.json` contiene soltanto i due script WordPress già presenti nella
consegna precedente; nessuna dipendenza o lockfile è stata modificata da questo
intervento.

## Analisi statica: fatti distinti dalle prove mancanti

1. Il test, nella funzione `auditRowsForRequest` alle righe 182–195, seleziona
   `AuditLog` con `"after" ->> 'requestId' = requestId` usando l'UUID originale.
   Alla riga 604 attende esattamente una riga dopo il rifiuto `CAS_MISMATCH`.
2. In `src/lib/ai-orchestrator/admin-control-plane-v1.ts`, `auditBlocked`
   attende `tx.auditLog.create`. Il ramo CAS attende a sua volta `auditBlocked`
   prima di restituire il rifiuto. `withSerializableTransaction`, in
   `src/lib/serializable.ts`, attende la transazione Prisma. Nel percorso letto
   non compare una scrittura audit sganciata dalla transazione o non attesa.
3. L'audit di rifiuto contiene colonne strutturali `actorId`, `event`,
   `entityType`, `entityId` e un payload con `requestId`, `requestHash`, target,
   operazione ed esito. Per il CAS non viene aggiunta una revisione al ledger.
4. La migration
   `20260817120000_privacy_consent_data_classification_foundation_v1` applica
   `audit_sanitize_json_n04_v1` a `before` e `after` tramite trigger. Le chiavi
   tecniche ammesse non esentano i loro valori stringa da
   `audit_redact_text_n04_v1`; quest'ultima include regole numeriche con trattini
   ammessi come separatori. Questa è una base concreta per verificare
   l'interferenza con UUID, non una riproduzione PostgreSQL già eseguita.
5. La documentazione del Control Plane richiede identità tecnica e audit
   ricostruibile; N04 documenta la minimizzazione del payload generico. Non è
   lecito dedurre dalla sola redazione che un evento sia assente, né che sia
   ancora correttamente correlabile. La presenza di `requestHash` non è stata
   usata come prova automatica di integrità o come giustificazione per cambiare
   la query del test.

**Non verificati dinamicamente:** presenza fisica dell'evento del caso
riprodotto, `requestId` effettivamente persistito, risultato della query
originale, conservazione della correlazione tramite identità indipendente,
controlli negativi per evento assente/duplicato/richiesta errata e ripetizioni
deterministiche su fixture isolate. Il log CI consultato non fornisce questi
valori per il run fallito. Non viene dichiarato né un bug del solo test né una
violazione dimostrata del contratto audit.

## Docker: inventario locale, nessun utilizzo

Contesto verificato: `desktop-linux`.
Endpoint: `npipe:////./pipe/dockerDesktopLinuxEngine` (locale).
Il digest PostgreSQL è stato confermato anche con `docker image inspect`:
`linux/amd64`, entrypoint `docker-entrypoint.sh`, comando `postgres`.

Inventario completo da `docker image ls --all --digests --no-trunc`:

| Immagine già presente | Digest |
| --- | --- |
| `postgres:16` | `sha256:287eced1f33b59ed265ed13a60d3680dd7646d70c4dc0e785f59a470ebc03eeb` |
| `wordpress:7.0.2-php8.4-apache` | `sha256:77bb03bd978b0654e38446b1c98400f8a0e187654e72cead120ea5e30f50d741` |
| `php:8.4.24-apache` | `sha256:5f8050825b2f3de4efb0d81149c86643a9ee9c0a74ed4595ca2ad69ebfeb35fb` |
| `mariadb:11.4` | `sha256:67873d30a17f6a9c331f06363b2fa15f38abca415529966d67c84f87f82439fe` |
| `alpine:3.22` | `sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce` |
| `nginx:1.29-alpine` | `sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de` |

Il repository richiede Node.js 22 (`.nvmrc`); `test:db` esegue Node con `tsx` e
il percorso applicativo utilizza Prisma 5.22.0. La presenza di `psql`
nell'immagine PostgreSQL non equivale alla disponibilità di questo runner:
un inserimento SQL costruito manualmente non validerebbe da solo l'intero
percorso applicativo e la suite originale. Non sono stati introdotti tunnel,
proxy, porte pubblicate o esenzioni dal guard per utilizzare il runner host.

Risorse preesistenti rilevate, non usate né modificate:

- container `eebe24e86126`, nome `fai-crm-postgres`, già `Exited (0)`;
- reti `bridge` (`cead12cbfb19`), `host` (`147b7627b12f`), `none` (`cce28d7c1322`);
- volume `a613f610d45792ee0a6d0e6337cab2078f7aaf0813b8d171c5aeb819abd74ad2`.

## Chiusura della sessione e minima condizione di ripresa

- Immagini usate per eseguire container: nessuna.
- Container/reti/volumi creati: zero; nomi e label di sessione: non applicabili.
- Scritture o migrazioni su database: zero.
- Pulizia: nessuna risorsa di sessione da rimuovere; nessuna rimozione eseguita.
- Modifiche al test/runtime/schema/migrazioni/workflow/dipendenze: nessuna.
- Unico nuovo file: questa evidenza locale, non staged e non committata.
- Nessun commit, push, aggiornamento PR, passaggio Ready, rerun CI o inoltro.
- HEAD e worktree tracked conservati; nessun residuo Docker di questa sessione.

Per riprendere occorre rendere disponibile localmente un'immagine runner Linux
compatibile, con provenienza e digest verificabili, Node.js 22, dipendenze
coerenti con il lockfile, `tsx` e Prisma/client/engine Linux utilizzabili senza
download. Un'eventuale importazione o preparazione dell'immagine richiede una
decisione separata della Cabina: non è stata inferita dall'autorità di avvio dei
container. Non è necessario ampliare il perimetro dei file o attenuare i gate.
Un runner in namespace di rete condiviso con il solo PostgreSQL effimero
consentirebbe di mantenere il target loopback richiesto dal guard senza
pubblicare porte; questa configurazione è solo una proposta da verificare,
non un isolamento già collaudato.

Alla ripresa resta obbligatorio dimostrare separatamente evento, identità
persistita e query, con casi deterministici e di controllo e numero di
ripetizioni prefissato. Solo dopo tale prova è valutabile una correzione del
test nei due file autorizzati. Un difetto di correlazione del runtime impone
ancora STOP. La disponibilità del runner non equivale a prova della causa.

F01 resta soggetto a ricontrollo indipendente. F02 non è dichiarato chiuso:
Antonio deve fornire il dossier originale integrale come allegato accessibile
al Revisore; un percorso locale non lo sostituisce. La PR resta Draft e non
pronta per il ricontrollo. `activation_authorized=NO`;
`automatic_next=FORBIDDEN`.
