# VNX-01 — Lead Intake Operational Bridge v1

## Stato e confine

VNX-01 collega la durable inbox N11 al proiettore N13 tramite un processo manuale, finito e
controllabile. Il deploy resta dormiente: nessun servizio Compose, route, startup hook, timer,
cron o scheduler avvia il consumer. N12, N14, worker AI, dispatch AI, provider esterni e agenti
non vengono attivati.

Il consumer usa esclusivamente:

- `recoverExpiredBusinessQueueLeases` per un recovery N11 bounded;
- `claimBusinessQueueEvent` per il claim `INBOX` con lease, fencing token e `SKIP LOCKED`;
- `projectClaimedLeadInboxEvent` per projection N13, privacy evidence e completion atomica;
- le primitive N11 già esistenti per retry e dead-letter.

Non sono aggiunte tabelle, colonne o migration. La baseline resta di 43 migration.

## Gate e configurazione fail-closed

`npm run vnx01:lead-intake` termina senza connettersi al database e senza reclamare eventi quando
`VNX01_LEAD_INTAKE_CONSUMER_ENABLED` è assente, vuoto o `0`. Qualsiasi altro valore diverso
dall'esatto `1` è invalido.

Con gate `1` sono obbligatori, prima di recovery o claim:

| Variabile | Contratto |
| --- | --- |
| `WEBSITE_LEAD_MODE` | deve essere esattamente `disabled`, preservando il prerequisito N13 contro writer N01 concorrenti |
| `VNX01_LEAD_INTAKE_LEASE_OWNER_ID` | UUID v4 dedicato all'istanza |
| `VNX01_LEAD_INTAKE_BATCH_SIZE` | intero canonico tra 1 e 100 |
| `VNX01_LEAD_INTAKE_RECOVERY_BATCH_SIZE` | intero canonico tra 1 e 100 |
| `LEAD_IDENTITY_KEY_FILE` | path non vuoto; il parser N13 applica root privata, formato, 32 byte e assenza di symlink |

Prima di mutare la coda, il consumer legge la key e verifica in sola lettura il consenso con
l'unica versione N13 `ACTIVE`. Configurazione mancante, incoerente, key non valida o consenso DB
assente bloccano quindi recovery e claim.

## Esecuzione e arresto

Ogni invocazione esegue un solo recovery bounded e reclama al massimo il batch configurato,
sequenzialmente. Più processi possono concorrere perché N11 applica `FOR UPDATE SKIP LOCKED`, CAS,
owner, token e fencing. Il processo non conserva payload o lease oltre la singola invocazione.

`SIGINT` e `SIGTERM` fermano nuovi claim. Se un evento è già stato reclamato, la projection corrente
termina entro i timeout transazionali N11/N13 e chiude la lease come `PROCESSED`, retry o
dead-letter. Un arresto non recuperabile resta coperto dall'expiry e dal recovery N11 della
successiva esecuzione.

I log JSONL usano un vocabolario chiuso di stato, contatori e failure code. Non includono envelope,
event/correlation/lead/case ID, lease token, hash, email, telefono, nomi, note, payload, path di key,
secret o messaggi di eccezione.

## Coda operatore duplicati

La pagina `/leads/duplicates` richiede `lead.duplicate.resolve`, permesso non delegabile riservato
ad `admin` e `direzione`. La lettura espone soltanto i campi di identità necessari al confronto e
rifiuta una coda con envelope, record hash, ledger o snapshot incoerenti.

Per mantenere la query operativa bounded, un caso con più di 500 candidati conserva l'intero
snapshot N13 ma mostra il prefisso dei primi 500 secondo il ranking deterministico. La vista verifica
separatamente che il conteggio persistito della revisione sia esatto e segnala esplicitamente
all'operatore che la finestra è troncata, senza classificare il caso valido come corrotto.

Le decisioni usano la server action N13 esistente e richiedono session registry viva, privileged
access `enforced`, step-up session-bound, versione attesa del caso e candidate snapshot corrente.
L'operatore può:

- collegare senza sovrascrivere a uno dei Lead candidati attivi;
- creare un nuovo Lead con il mapping N13 quando nessun candidato coincide.

Lock globale, transazione serializable, optimistic version e storico append-only assicurano un solo
esito valido per replay, doppio invio o concorrenza. L'audit decisionale conserva soltanto codici,
versioni e conteggi minimizzati.

## N14 sintetico e dormienza produzione

Il proiettore e la risoluzione `CREATE_NEW` continuano a chiamare
`maybeEnrollProjectedCommercialLead`. I test DB effimeri possono impostare N14 `enforced` con una
policy sintetica e verificare un solo enrollment. In produzione
`COMMERCIAL_LEAD_INBOX_MODE=disabled`: VNX-01 non crea policy, non abilita enforced e non avvia
alcun processo N14.

## Deploy dormiente e rollback

Un deploy autorizzato deve mantenere il gate VNX-01 a `0`, `LEAD_IDENTITY_KEY_FILE` vuoto, N12 e
N14 disabilitati e nessun nuovo container/processo consumer. Non si esegue `prisma migrate deploy`
per VNX-01 perché schema e migration non cambiano.

Il rollback applicativo usa l'immagine precedente immutabile qualificata. Con il consumer mai
attivato e senza dati reali non è richiesto alcun rollback dati. Qualsiasi activation, provisioning
di key, traffico reale o abilitazione N14 richiede un mandato distinto.
