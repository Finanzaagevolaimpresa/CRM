# VNX-02 — evidenze test Docker locali sintetici R01

Data: 2026-09-04. Base Git: `18c8bf252cca9d6f1ff369e3d4f69149ef462f69`.
Branch: `codex/vnx02-wordpress-secure-lead-connector`.
Sessione effimera: `vnx02-20260904-mtne8bc2`.

## Immagini già locali

| Immagine | Digest utilizzato | Runtime osservato |
| --- | --- | --- |
| `wordpress:7.0.2-php8.4-apache` | `sha256:77bb03bd978b0654e38446b1c98400f8a0e187654e72cead120ea5e30f50d741` | WordPress 7.0.2 / PHP 8.4.24, 64 bit |
| `mariadb:11.4` | `sha256:67873d30a17f6a9c331f06363b2fa15f38abca415529966d67c84f87f82439fe` | MariaDB 11.4.12 |

Tutte le esecuzioni hanno usato il digest e `--pull never`. Nessun pull, download, build immagine,
installazione online o contatto esterno. Sono presenti curl, intl, JSON, mbstring, mysqli, sodium e zip.

## Isolamento verificato

- Container PHP con UID/GID `33:33`, MariaDB con `999:999`; root filesystem read-only.
- Repository montato esclusivamente `/workspace:ro`; nessun mount host nel DB.
- Scritture container soltanto in tmpfs `/tmp`, `/var/www/html`, `/var/lib/mysql`, `/run/mysqld`.
- `--cap-drop ALL`, `no-new-privileges`, limiti memoria e processi; nessun privilegio o Docker socket.
- Prove PHP con `--network none`; prove DB/WordPress con rete `--internal` e namespace del solo DB.
- MariaDB vincolato a `127.0.0.1` nel namespace isolato; nessuna porta pubblicata.
- Database dedicato `fai_vnx02_test`, credenziali/chiavi/contatti esclusivamente sintetici.
- WordPress copiato dall'immagine locale al tmpfs; cron, aggiornamenti, HTTP ed email bloccati nel fixture.

## Risultati finali

| Prova | Risultato |
| --- | --- |
| Lint PHP di tutti i file plugin e fixture | PASS |
| `vnx02-wordpress-secure-lead-connector.test.php` | 11/11 PASS |
| `vnx02-wordpress-queue-mysql.test.php` su MariaDB | PASS |
| 8 processi concorrenti su un record | una lease; sette EMPTY |
| 16 processi su otto record | otto lease distinte; otto EMPTY |
| Replay, conflitto contenuto, recovery lease, ciphertext cancellato a fine consegna | PASS |
| Retry/esaurimento dopo cinque tentativi, anche senza key; trasporto worker finto | PASS |
| Confronto PHP → parser/canonicalizzazione/digest/HMAC TypeScript N10/N12 | PASS, nessuno skip |
| Test TypeScript VNX-02 | 5/5 PASS |
| ZIP installato su WordPress effimero, default-off, callback sintetico e claim wpdb | PASS |
| Disattivazione: cron rimosso, tabella preservata; disinstallazione: file plugin rimossi | PASS |
| Pulizia selettiva | `VNX02_SELECTIVE_CLEANUP_PASS` |

Il test WordPress usa le API reali di installazione/attivazione/disattivazione/disinstallazione.
WPForms non è installato: il callback riceve campi sintetici mediante `do_action`. Nessuna prova
end-to-end della UI WPForms o del TLS verso un gateway viene rivendicata. La matrice HTTP usa un
trasporto finto; l'equivalenza della firma è verificata direttamente contro il codice N12.

Le prove hanno individuato e corretto un deadlock nel precedente claim con UPDATE concorrente e una
lettura errata dell'adapter wpdb. Il claim finale usa una transazione breve READ COMMITTED con
SKIP LOCKED; la rete avviene dopo il commit. La suite include il comportamento di retry con key assenti.

## Pacchetto verificato

`fai-secure-lead-connector-1.0.0.zip`, 14 entry, SHA-256:
`643bd4db3449a5ae26760d114edb84fccb803950211aa6b10724a104608df65f`.

Il ZIP è generato localmente in `dist/` (ignorata da Git); i sorgenti e il packager sono versionati.

## Risorse rimosse

Tutti i nomi riportati hanno il prefisso `vnx02-20260904-mtne8bc2-`:

- Container `php-probe`, `db-probe`, `php-tests`, `php-final`, `php-fixture`, `queue-tests`, `wp-install`
  rimossi automaticamente con `--rm`, anche dopo le prove inizialmente fallite.
- Container `db` fermato e rimosso dopo verifica del nome e della label di sessione.
- Rete interna `net` rimossa dopo il DB.
- Nessun volume Docker creato; tutti i dati sintetici erano in tmpfs.

Controllo finale: nessun container/rete con la label della sessione. Il container preesistente
`fai-crm-postgres` è rimasto fermo, le tre reti standard e l'unico volume preesistente sono invariati.
Nessuna immagine rimossa o modificata. Nessuna scrittura dei container al worktree, né accesso a CRM,
WordPress reale, produzione, Governance o database reali. `activation_authorized=NO`.
