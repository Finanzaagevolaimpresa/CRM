# VNX-05 — Selezione esplicita del consumer Lead Intake

VNX-05 aggiunge una selezione finita alla stessa invocazione manuale
`npm run vnx01:lead-intake`. Non aggiunge processi automatici, servizi o migrazioni.
La selezione delimita gli eventi elaborabili da quell'invocazione; non conferisce
diritti sui dati e non autorizza un pilota reale, provisioning o attivazioni.

## Selettore e configurazione

Restano obbligatori il gate VNX-01, `WEBSITE_LEAD_MODE=disabled`, owner dedicato,
batch, recovery batch, file della chiave e consenso N13 descritti in
[VNX-01](vnx01-lead-intake-operational-bridge-v1.md).

| Variabile aggiuntiva | Contratto |
| --- | --- |
| `VNX05_LEAD_INTAKE_PILOT_ENABLED` | Solo `1` abilita la selezione pilota; assente, vuota o `0` la disabilita. Altri valori sono invalidi. |
| `VNX05_LEAD_INTAKE_INBOX_EVENT_IDS` | Con pilota `1`, array JSON di 1–100 UUID v4 distinti, canonici, minuscoli e lunghi esattamente 36 caratteri. Testo JSON massimo 8192 caratteri. Con pilota spento deve essere assente o vuota. |

L'unico identificatore accettato è **`BusinessInboxEvent.id`**, chiave stabile
della riga N11, restituita dall'ammissione come `inboxEventId`. Non viene cercato
l'`eventId` dell'envelope, un identificatore di modulo, submission o Lead.
Esempio esclusivamente sintattico con UUID sintetico:

```text
VNX05_LEAD_INTAKE_INBOX_EVENT_IDS=["00000000-0000-4000-8000-000000000005"]
```

Array vuoti, duplicati, elementi non stringa, UUID non canonici, liste CSV,
oggetti, selezione mancante, selezione oltre limite e selettore senza gate pilota
falliscono prima del preflight e di qualsiasi mutazione. La validazione pilota
avviene anche quando il gate VNX-01 è chiuso. Con selezione valida e gate VNX-01
chiuso l'esito è `DISABLED`, senza accesso operativo al database.

La configurazione e una copia dell'array sono congelate prima del primo `await`.
Cambiare l'ambiente mentre il processo è in esecuzione non cambia la selezione.
Non esiste un ripiego pilota verso la coda globale. I chiamanti ordinari che
omettono il selettore mantengono il comportamento precedente.

## Confine transazionale

Le primitive `claimBusinessQueueEvent` e `recoverExpiredBusinessQueueLeases`
accettano l'opzione `inboxEventIds`, la validano e ne congelano una copia prima
della transazione e dei relativi retry. Un selettore fornito per OUTBOX viene
rifiutato; OUTBOX senza selettore conserva il contratto ordinario.

Il predicato SQL parametrizzato su `BusinessInboxEvent.id` è nella query dei
candidati, prima di `ORDER BY`, `LIMIT` e `FOR UPDATE SKIP LOCKED`, sia per claim
sia per recovery. Eventi estranei non vengono reclamati, recuperati, ripristinati
o mandati in dead-letter. UUID inesistenti o riferiti a righe non disponibili non
producono candidati sostitutivi. L'ordine dell'array non determina la priorità:
resta l'ordine N11 per disponibilità/scadenza e ID.

Completamento, retry e dead-letter operano sulla lease ottenuta da quel claim,
con le verifiche N11/N13 esistenti. Restano immutati integrità degli eventi,
transazioni, lease, CAS, fencing, massimo cinque tentativi, backoff, timeout,
concorrenza sequenziale del consumer e limiti dei batch. Il recovery può essere
più piccolo della selezione: non è garantito che una sola invocazione esaurisca
la selezione o recuperi ogni lease selezionata.

La selezione degli eventi non limita la ricerca dei Lead candidati N13. I Lead
già presenti e gli altri candidati pertinenti continuano a concorrere alla
deduplicazione; le ambiguità restano nella coda operatore protetta. Consenso della
chiave, ricevute privacy, idempotenza e proiezione N13 non cambiano.

## Esiti, errori e arresto

- `COMPLETED`: l'invocazione finita è terminata; non significa che tutti gli ID
  selezionati siano stati proiettati. Eventi futuri, leased, terminali o assenti
  possono non essere reclamati; batch e backoff restano applicabili.
- `STOPPED`: `SIGINT`/`SIGTERM` impedisce nuovi claim. La proiezione già in corso
  termina secondo i limiti N11/N13 e il riepilogo conserva i suoi contatori.
- Se un claim successivo fallisce, viene emesso un riepilogo `FAILED` con i
  contatori già riconosciuti; l'entrypoint emette il codice di rifiuto ed esce
  con errore. Non viene annullato il lavoro committato in precedenza.
- Un crash non recuperabile può impedire il riepilogo finale. Gli esiti già
  committati rimangono nel database; la successiva invocazione esplicitamente
  selezionata applica recovery, backoff e fencing N11 alle lease scadute.

Il lotto non è atomico. I contatori nei log sono quelli riconosciuti dal
processo, non una riconciliazione completa del database dopo un crash.
Per riprendere si usa un'invocazione autorizzata con la selezione esplicita
appropriata. Le righe già terminali non producono una seconda proiezione.

I codici di configurazione aggiuntivi sono `VNX05_PILOT_GATE_INVALID`,
`VNX05_PILOT_CONFIG_INVALID` e `VNX05_SELECTION_INVALID`; la primitiva N11 usa
`BUSINESS_INBOX_SELECTION_INVALID`. I log conservano soltanto eventi, stati,
codici e contatori: nessuna selezione, UUID, chiave, path, payload o messaggio
arbitrario di eccezione viene serializzato.

## Qualificazione e dormienza

`npm run test:vnx05:db` usa esclusivamente il guard esistente per PostgreSQL
effimero: database `fai_crm_test`, loopback, schema iniziale `public`, consenso
sintetico e sentinel verificato. Crea un proprio schema, applica le 43 migrazioni
esistenti e lo rimuove al termine. Le fixture di chiavi e privacy sono sintetiche.
La suite verifica snapshot completi delle righe, lease e tentativi estranei,
INBOX mista, OUTBOX, ID non risolvibili, rifiuti prima delle mutazioni, processi
con selezioni sovrapposte, replay, crash, SIGTERM, N13 e assenza di seconde
proiezioni. La scadenza di 60 secondi e il backoff sono reali; la nuova suite non
disabilita trigger né altera l'orologio.

La CI conserva tutti i gate precedenti, inclusi A05/N05 e VNX-03, e aggiunge
`scripts/vnx05/packaging-smoke.sh`. Il suo gate test-only
`VNX05_SYNTHETIC_TESTS_CONFIRMED=1` consente di costruire l'immagine applicativa
con commit/tree esatti e qualificare l'entrypoint realmente incluso, dopo la
rimozione delle dipendenze di sviluppo. Solo i test sono montati in lettura;
codice applicativo, entrypoint, Prisma e dipendenze provengono dall'immagine.
PostgreSQL e consumer condividono una rete interna senza porte pubblicate,
con storage e chiavi sintetiche temporanei. Il cleanup riguarda soltanto nomi
di risorse nuovi e propri della prova e fallisce se la rimozione non riesce.

Schema Prisma, 43 migrazioni e configurazioni produttive attive restano invariati.
La consegna del codice non applica mount, non effettua deploy e non attiva
consumer, N14, provider, dispatch, worker o scheduler. Il perimetro delle sorgenti
del futuro pilota reale resta una decisione separata. Il recupero del codice prima
del merge avviene sul branch dedicato; dopo merge richiede una PR correttiva con
i relativi gate, senza rollback produttivo o dei dati.
