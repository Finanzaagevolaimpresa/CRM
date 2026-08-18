# N06 — Telemetry, SLO & Redaction Foundation v1

## Stato e confine

N06 definisce un contratto interno, versionato e fail-closed per segnali operativi minimizzati. Non attiva monitoring, persistenza, collector, exporter, dashboard, alerting o network egress.

- Schema e catalogo: `n06-v1`.
- Transport: `NONE`.
- Persistence: `NONE`.
- Exporter e endpoint esterni: vietati.
- Dati ammessi: codici operativi allowlisted e dati sintetici.
- Test e qualifiche: locali o effimeri.
- Migration: nessuna; la baseline resta a 35.
- Feature gate e runtime N01–N05: invariati e dormienti.

La libreria `src/lib/operational-telemetry.ts` non legge environment, non apre connessioni, non usa timer, non scrive su stdout/stderr e non ha side effect all’import.

## Threat model

Il confine considera ostili o non affidabili:

- body, header, cookie, URL e query string in ingresso;
- nomi, email, telefoni, codici fiscali, partite IVA, PEC e indirizzi;
- prompt, output AI e contenuto documentale;
- password, API key, token bearer, webhook secret e connection string;
- messaggi, stack, cause, query, path e metadata degli errori;
- chiavi con casing alternativo, fullwidth, caratteri di formato o omografi Unicode;
- oggetti nested, array, accessor, strutture circolari e payload oversized;
- label, event code o correlation ID controllati da un chiamante esterno.

Il contratto non tenta di rendere sicuro il free text: lo vieta. I valori stringa sopravvivono esclusivamente quando la chiave e il valore appartengono a un dominio finito del catalogo. I campi sconosciuti sono rifiutati dai builder o eliminati dal redattore.

## Matrice fonti e trattamento

| Fonte | Dato osservabile minimo | Classificazione N04 | Trattamento | Retention/logging |
| --- | --- | --- | --- | --- |
| `/api/health` | stato, raggiungibilità DB, timestamp | INTERNAL | evento health allowlisted; nessun dettaglio connessione | sola risposta HTTP; nessuna persistenza N06 |
| `system-readiness` | presenza configurazione e stato | INTERNAL | presenza/stato; mai valori secret | UI autenticata esistente |
| middleware/sessioni | esito autenticazione | INTERNAL, AUTHENTICATION_SECRET | solo outcome; cookie e token vietati | non emesso da N06 |
| website lead | outcome e duration bucket | INTERNAL, PERSONAL, FINANCIAL | codici operativi; body/header/URL/ID vietati | non emesso da N06 |
| `AuditLog` | audit applicativo | INTERNAL, CONFIDENTIAL, PERSONAL | redazione applicativa e trigger DB N04 | governance DB esistente invariata |
| heartbeat worker dormant | build, stato, sequenza, timestamp, instance UUID | INTERNAL | heartbeat bounded esistente; instance UUID vietato come label | stdout esistente invariato |
| script N05 | fasi, conteggi, image identity, risultato | INTERNAL | codici e identità immutabili; niente secret/contenuti | log operatore esistente |
| errori Prisma/PostgreSQL/app | classe e retryability | INTERNAL, AUTHENTICATION_SECRET, PERSONAL | mapping allowlisted; niente message/stack/query/cause/path | descrittore pubblico o evento effimero |

La costante `OPERATIONAL_SOURCE_INVENTORY` rende la stessa matrice ispezionabile e testabile.

## Envelope eventi

Un evento canonico contiene esclusivamente:

1. `schemaVersion`;
2. timestamp UTC ISO 8601 derivato da un clock interno;
3. severity determinata dal catalogo;
4. `eventCode` stabile;
5. `componentCode` determinato dal catalogo;
6. outcome appartenente al dominio dell’evento;
7. correlation ID UUID v4 canonico generato internamente;
8. metadata con chiavi esatte e domini finiti.

Limite serializzato: 2 KiB. Non sono ammessi free text, payload raw, ID cliente/utente/pratica/documento, URL, IP, host o valori arbitrari.

Gli eventi N06 sono:

- `APP_HEALTH_CHECK_COMPLETED`;
- `DATABASE_REACHABILITY_CHECK_COMPLETED`;
- `CRITICAL_OPERATION_COMPLETED`;
- `FAIL_CLOSED_GATE_EVALUATED`;
- `OPERATIONAL_TASK_FRESHNESS_EVALUATED`;
- `INTERNAL_ERROR_MAPPED`.

La creazione dell’envelope non equivale a emissione. N06 non fornisce alcun transport.

## Metriche e cardinalità

Il catalogo contiene sei metriche locali astratte:

- disponibilità health;
- raggiungibilità database;
- outcome operazioni critiche;
- durata operazioni critiche;
- affidabilità gate fail-closed;
- freshness dei task operativi.

Ogni label è richiesta, allowlisted e limitata a un dominio finito. Sono vietati correlation ID, instance ID, email, nomi, ID applicativi e valori derivati da input libero. Le osservazioni numeriche devono essere interi safe e restare nei limiti specifici della metrica.

Le durate sono classificate nei bucket `<100 ms`, `<500 ms`, `<1 s`, `<5 s`, `>=5 s`. La freshness usa `<60 s`, `<5 m`, `<15 m`, `<1 h`, `>=1 h`. I valori oltre i limiti contrattuali sono rifiutati, non troncati silenziosamente.

## Error mapping

`classifyOperationalErrorV1` legge solo proprietà dati proprie e allowlisted. Non invoca accessor e non serializza l’errore originale.

| Input tecnico | Classe interna | Codice pubblico | Retryability |
| --- | --- | --- | --- |
| `P1001`, `P1002`, `P2024` | `DEPENDENCY_UNAVAILABLE` | `TEMPORARILY_UNAVAILABLE` | retryable |
| `P2034`, SQLSTATE `40001`, `40P01` | `CONCURRENCY_RETRYABLE` | `TEMPORARILY_UNAVAILABLE` | retryable |
| errore contratto N06 | `CONTRACT_REJECTED` | `INVALID_REQUEST` | non-retryable |
| qualsiasi altro errore | `INTERNAL_FAILURE` | `INTERNAL_FAILURE` | non-retryable |

Messaggi, stack, cause, path, query SQL e dettagli Prisma/PostgreSQL non attraversano il confine.

## SLI e SLO

Tutte le finestre sono rolling 30 giorni. Una misura mancante quando attesa è un failure, salvo esclusione dichiarata prima dell’evento.

| SLO | Target | Denominatore | Failure | Esclusioni |
| --- | ---: | --- | --- | --- |
| health applicativo | 99,90% | ogni probe interno completato | degraded, timeout, malformed o missing | manutenzione dichiarata prima dell’inizio |
| raggiungibilità DB | 99,90% | ogni check DB del contratto health | unreachable, timeout, invalid o missing | manutenzione dichiarata prima dell’inizio |
| successo operazioni critiche | 99,00% | tentativi accettati dopo auth e validazione sintattica | server failure, deadline o outcome ignoto | reject client prima dell’accettazione; drill sintetico autorizzato |
| latenza operazioni critiche | 95,00% sotto soglia | operazioni accettate completate con bucket valido | `GTE_5_S`, durata invalida o missing | reject client; drill sintetico autorizzato |
| affidabilità fail-closed | 100,00% | ogni valutazione gate, incluse configurazioni invalide | allow con prerequisiti mancanti/invalidi, ambiguità o missing | nessuna |
| freshness task | 99,00% | osservazioni pianificate per reconcile/backup verification | soglia superata, timestamp invalido o missing | task esplicitamente disabilitato dal contratto dormant |

I target definiscono il contratto per N07 e qualifiche future; N06 non raccoglie né esporta serie temporali.

## Failure matrix

| Failure | Comportamento |
| --- | --- |
| event/metric code sconosciuto | rifiuto con codice N06 stabile |
| outcome, label o metadata fuori dominio | rifiuto; il valore originale non appare nell’errore |
| correlation ID non UUID v4 canonico | rifiuto e generazione interna richiesta |
| timestamp o misura non bounded | rifiuto |
| campo sconosciuto nel builder | rifiuto fail-closed |
| campo sconosciuto nel redattore | eliminazione |
| free text | marker non reversibile; non ammesso negli envelope |
| accessor, circular, nesting eccessivo | accessor non invocato; ramo eliminato |
| errore ignoto | `INTERNAL_FAILURE`, non-retryable |
| tentativo di exporter/egress | assenza del transport e test di regressione |

## Runbook di adozione futura

1. Mappare la nuova sorgente nella matrice con classificazione N04.
2. Usare un event/metric code esistente; aggiungerne uno solo con dominio finito e test.
3. Generare correlation ID internamente; non fidarsi di header o input.
4. Convertire durate e freshness nei bucket canonici.
5. Non passare l’errore raw al client o al builder.
6. Aggiungere test negativo con secret/PII sintetici e label ad alta cardinalità.
7. Verificare che import e builder non producano I/O.
8. Non collegare un transport senza un blocco roadmap e un’autorizzazione separati.

## Verifica

Comandi locali:

```bash
node --import tsx --test tests/telemetry-slo-redaction-foundation.test.ts
npx tsc --noEmit --incremental false
npm run lint
npm run build
git diff --check
```

La CI generale esegue anche audit dipendenze, 35 migration, test DB effimeri, build e smoke Docker. Nessun test N06 usa dati reali.

**N06_TELEMETRY_SLO_REDACTION_FOUNDATION_READY**
