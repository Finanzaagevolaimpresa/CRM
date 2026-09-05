# VNX-02 — ricontrollo mirato F01/F02, evidenze R02

Data prove: 2026-09-04 UTC. Base autorizzata: `18c8bf252cca9d6f1ff369e3d4f69149ef462f69`.
HEAD oggetto di FIX_REQUIRED: `eac936914a2bb8ca4db0b545a6b921f41290c450`.
Branch invariato: `codex/vnx02-wordpress-secure-lead-connector`, PR #115.

## F01 — ripresa indipendente dal worker

`Plugin::recoverQueue` è registrato su `init` ed è chiamato anche dopo l'installazione della
tabella nel lifecycle di attivazione. Con configurazione valida e `enabled=true`, se manca
l'evento e la coda è pronta e contiene `PENDING` o `LEASED`, ripristina un single event alla
prossima disponibilità/scadenza. Non invia HTTP, reclama righe, azzera tentativi o modifica body.
Un evento esistente resta invariato. Default-off, configurazione invalida, coda non pronta,
coda vuota o solo terminale non producono eventi. Un errore di scheduling resta recuperabile
al successivo bootstrap; il logging conserva il vocabolario chiuso esistente.

La ripresa non dipende dal `finally` del worker né da una nuova submission. Dipende dal normale
bootstrap WordPress e dal processamento dei suoi cron: nessuna garanzia wall-clock senza
richieste/trigger wp-cron autorizzato. Non viene installato alcuno scheduler esterno o ricorrente.

## Prove sintetiche finali

- Lint PHP: 19 file PASS; suite contratto/sicurezza: 11/11 PASS.
- Suite scheduling inclusa in `npm run test:wordpress-connector` e CI: 10/10 PASS.
  Configurazione assente/disabilitata/invalida, coda vuota, pending, lease attiva/scaduta,
  evento esistente, database indisponibile e fallimento di scheduling recuperabile.
- MariaDB: suite replay, concorrenza, lease, recovery e worker preesistente nuovamente PASS.
- Lifecycle del ZIP su WordPress effimero, con richieste PHP distinte e API WordPress reali:
  - attivazione default-off, enqueue sintetico, disattivazione e riattivazione con coda pending;
  - nessun risveglio con configurazione assente/disabilitata/invalida;
  - bootstrap abilitato senza submission: un evento soltanto, preservato sui bootstrap successivi;
  - processo worker terminato con `exit(86)` prima del claim, dopo il consumo del cron;
  - processo worker terminato con `exit(87)` dopo COMMIT della lease, prima di invio/finally;
  - recupero senza cron residuo, rispetto della lease ancora attiva e ripresa della lease scaduta;
  - stesso record, digest e ciphertext nei retry; contatore non azzerato; esaurimento a cinque;
  - replay terminale senza nuova riga/evento; disattivazione e disinstallazione preservano la tabella.
- I worker ripresi usano un path key sintetico assente, per verificare retry senza alcun egress.
  La matrice del trasporto finto/202 e la firma N12 restano coperte dalle suite esistenti.
- Test TypeScript VNX-02 con fixture PHP offline fresca: 5/5 PASS, zero skip.
- Lint e typecheck locali: PASS; build-context guard: 12/12 PASS.
- CI completa sul nuovo HEAD: evidenza finale e URL nella PR, non desunti dai test locali.

Le scadenze della sola riga sintetica sono accelerate con SQL nel fixture, senza attese né
database reali. I primi tentativi hanno rilevato un parametro porta mancante nel comando test e
un doppio caricamento delle classi nel fixture WordPress; entrambi corretti prima delle prove PASS.
Il processo figlio ora carica i contratti dallo stesso ZIP installato, non da una seconda copia.

## ZIP qualificato

`fai-secure-lead-connector-1.0.0.zip`, 14 entry, SHA-256:
`a612b3eeeceec1cbdf27acb9f0c1377b951d45ad976cdf8a8e75750708b78140`.
Le evidenze R01 restano lo storico dell'artefatto precedente; questo digest identifica la correzione F01.

## Isolamento e pulizia

Sessione: `vnx02-20260904-f01-6e30c218`.
Immagini preesistenti, usate esclusivamente con `--pull never`:

- WordPress 7.0.2 / PHP 8.4.24:
  `wordpress@sha256:77bb03bd978b0654e38446b1c98400f8a0e187654e72cead120ea5e30f50d741`.
- MariaDB 11.4.12:
  `mariadb@sha256:67873d30a17f6a9c331f06363b2fa15f38abca415529966d67c84f87f82439fe`.

Container con prefisso di sessione e suffissi `php`, `fixture`, `wordpress`: `--rm`, UID/GID
33:33, repository `/workspace:ro`, root read-only, soli tmpfs `/tmp` e `/var/www/html`.
Container `db`: UID/GID 999:999, nessun mount host, tmpfs `/tmp`, `/var/lib/mysql`, `/run/mysqld`.
`cap-drop ALL`, `no-new-privileges`, limiti memoria/processi, nessun Docker socket o porta pubblicata.
PHP puro in `network none`; WordPress/DB nel namespace del DB sulla rete `net` interna, con
MariaDB in ascolto solo su `127.0.0.1`. Nessun pull, download, registry o servizio esterno contattato.

`db` e `net` rimossi dopo verifica esatta di nome e label; gli altri container rimossi anche dopo
le prove fallite. Nessun volume creato. Esito: `VNX02_SELECTIVE_CLEANUP_PASS`.
Container preesistente `fai-crm-postgres` sempre fermo, reti bridge/host/none e unico volume
preesistente invariati; nessuna immagine modificata o rimossa. Tutti i dati DB di test erano in tmpfs.

## F02 — fonti originali e confini

Mandato R01, DoD inclusa, e integrazione Docker R01 sono preparati come allegato locale per Antonio,
con testi integrali e provenienza; non vengono caricati nel repository o nella PR. Il rapporto
di ricontrollo identifica il nuovo HEAD e la CI per il confronto con la base autorizzata.
Le fonti storiche non sono nuove autorizzazioni operative. Il PASS del Revisore resta necessario.

Nessun delta al runtime CRM, Prisma o alle 43 migrazioni; nessuna modifica Governance, produzione,
sito reale, credenziali reali o attivazione. Limiti UI WPForms e TLS reale invariati.
Rollback della correzione mediante revert revisionato; nessuna azione di rollback eseguita.
`activation_authorized=NO`.
