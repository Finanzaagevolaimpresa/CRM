# ADR-0009 — AI Orchestrator Admission, Claim & Lease Wiring Foundation v1

- Stato: Proposto nella Draft PR82
- Data: 2026-07-23
- Dipendenze: ADR-0003, ADR-0006, ADR-0008

## Contesto

PR76 ha introdotto primitive PostgreSQL transazionali per admission, claim,
lease, fencing, heartbeat, recovery, supersession e surrender. PR81 ha
introdotto un processo manuale e dormiente che, con gate `0`, non importa
Prisma e non apre connessioni database.

Il collegamento fra questi livelli deve riusare le primitive PR76 senza esporre
completion, failure, handler o payload. Deve inoltre distinguere il desired
state amministrativo dall'autorità operativa e preservare il comportamento
PR81 quando il worker è disabilitato.

## Decisione

Introduciamo tre confini versionati:

1. un coordinatore puro e single-flight per recovery, supersession, authority,
   admission, claim, heartbeat, surrender e drain;
2. una facade runtime con handle lease opaco, che non espone token, payload,
   `complete`, `fail`, result o artifact;
3. un lettore Control Plane machine-safe, `READ ONLY` e default-deny, che valida
   catene ledger, setting, capability e barriera fisica senza impersonare un
   amministratore.

Il gate ambiente seleziona il processo:

- assente o `0`: percorso PR81 invariato, senza import Prisma;
- `1`: validazione exact-match mock/synthetic e caricamento lazy PR82;
- altro valore: arresto fail-closed.

Il manifesto PR81 resta immutato. PR82 usa un nuovo manifesto
`FAI-AI-ORCHESTRATOR-WORKER-ADMISSION-CLAIM-LEASE` versione `1.0`, hashato
separatamente.

## Non-authority production

La composizione production fissa `canAcceptLease=false` e non fornisce alcun
lease consumer. `FOUNDATION_LOCKED_V1` mantiene inoltre l'autorità
`operational=false`, `databaseEligible=false`, `canAdmit=false`,
`canClaim=false` e `canHeartbeat=false`.

PR76 mantiene recovery, supersession e surrender come primitive bounded di
riduzione del rischio. PR82 sceglie però il vincolo più forte richiesto dalla
foundation: authority positiva e lease acceptance precedono ogni mutatore DB,
incluse recovery e supersession. Soltanto il surrender di una lease già
posseduta resta consentito durante il drain se l'autorità viene successivamente
chiusa. Con la composizione distribuita PR82, che resta
`FOUNDATION_LOCKED_V1` e `canAcceptLease=false`, nessun mutatore è
raggiungibile.

## Concorrenza e drain

Non sono consentite operazioni o attese sovrapposte. Le transazioni brevi
restano interne alle primitive PR76; il coordinatore non mantiene transazioni
durante polling o timer.

Se il drain arriva mentre un claim è in corso, la risposta committata viene
registrata localmente e surrenderata una sola volta. Heartbeat e surrender
sulla stessa lease vengono serializzati. Un handle stale viene eliminato e non
può essere riutilizzato. Disconnect e surrender sono once-only per lifecycle.

Gli errori DB transienti riconosciuti vengono ritentati dall'adapter con un
massimo di tre tentativi complessivi, backoff breve e jitter deterministico.
Esaurimento e database indisponibile restano codici distinti e arrestano il
processo fail-closed; non esiste alcun retry infinito.

## Confini esclusi

Questa decisione non autorizza:

- handler mock o reali;
- lettura di payload o dati CRM;
- persistenza di result, artifact, `AiRun` o `AiOutput`;
- complete, fail o transizioni workflow;
- HTTP, DNS, socket, provider esterni o OpenAI;
- servizio Compose, cron, systemd, scheduler o modifica del `CMD`;
- modifica schema Prisma, seed, backfill o migration;
- merge, deploy o avvio manuale sul VPS.

Il database resta a 29 migration e tutti i test positivi usano dati sintetici
e PostgreSQL effimero.

## Alternative escluse

### Import runtime diretto nello script

Rifiutato: esporrebbe una superficie che include terminalizzazione, payload e
Prisma prima della selezione del gate.

### Riutilizzo della action amministrativa UI

Rifiutato: richiede identità e permessi di un attore umano, mentre un processo
necessita una proiezione read-only e machine-safe.

### Claim seguito da surrender nella composizione production

Rifiutato: creerebbe attempt e audit inutili senza un consumer PR83.
`canAcceptLease=false` impedisce il claim.

### Nuova migration

Rifiutata: PR76 contiene già protocollo e vincoli necessari. Duplicarli
produrrebbe due autorità concorrenti.

## Conseguenze

Positive:

- il percorso gate `0` resta verificabilmente privo di database;
- payload e token lease non oltrepassano la facade;
- authority, fencing e lease acceptance sono controlli indipendenti;
- drain e race di claim hanno una semantica deterministica;
- PR83 potrà collegare il consumer mock senza ampliare la facade runtime.

Limiti:

- nessun job viene eseguito o completato;
- la composizione production non accetta lease;
- metriche e health specifici del worker restano fuori perimetro;
- le operazioni positive esistono solo come wiring testato con adapter
  sintetici.

## Rollback

Non sono presenti schema, migration, seed o backfill PR82. Il rollback
ordinario ripristina l'immagine PR81 `fai-crm:pr81-39ed9040ba83`, mantiene
gate `0` e lascia intatti database, 29 migration e ledger. Non usare down
migration, `DROP`, `TRUNCATE`, reset o restore come rollback applicativo.
