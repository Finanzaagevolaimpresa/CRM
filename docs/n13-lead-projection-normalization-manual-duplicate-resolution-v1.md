# N13 — Lead Projection, Normalization & Manual Duplicate Resolution v1

## Stato e confine autorizzativo

N13 introduce una foundation server-side dormiente per proiettare un evento N10 già ammesso e
preso in lease da N11, individuare possibili Lead omonimi senza dedurne l'identità e registrare una
decisione umana non distruttiva.

Questo documento descrive il contratto del codice. VNX-01 aggiunge un consumer manuale
bounded e una vista operatore protetta, entrambi default-off sul runtime produttivo. Il codice non
autorizza provisioning di chiavi, traffico, projection reale o risoluzione di duplicati reali:
tali operazioni richiedono un mandato di activation separato.

La release N13 resta chiusa per costruzione:

- `LEAD_PROJECTION_MANIFEST.dormant = true`;
- `LEAD_PROJECTION_MANIFEST.runtimeConsumers = [VNX01_LEAD_INTAKE_CONSUMER]`;
- `LEAD_PROJECTION_MANIFEST.activation = EXPLICIT_ENV_GATE`;
- `LEAD_DUPLICATE_RESOLUTION_MANIFEST.dormant = true`;
- `LEAD_DUPLICATE_RESOLUTION_MANIFEST.activation = PROTECTED_OPERATOR_UI`;
- la route `/leads/duplicates` richiede `lead.duplicate.resolve` e una sessione privilegiata valida
  prima di esporre le azioni di decisione;
- `LEAD_IDENTITY_KEY_FILE` è vuoto negli esempi, nella CI, nello smoke e nel restore drill;
- nessuna route, cron, scheduler, timer o startup hook invoca il projector; l'unico call site
  runtime è lo script manuale VNX-01 e rifiuta il claim finché il gate e il preflight non sono validi;
- non vengono creati o attivati record `LeadIdentityKeyVersion` dalla migration o dai seed;
- non vengono aggiunti eventi N06, chiamate di rete, provider o telemetria N13.

## Ownership e trust boundary

L'entrypoint automatico è
`projectClaimedLeadInboxEvent(prisma, leaseIdentity, options)`. Accetta esclusivamente una lease
N11 `INBOX` già acquisita. Non effettua claim, heartbeat o recovery e non consulta le receipt N12.

La primitiva N11 `processClaimedBusinessInboxEventInTransaction`:

1. rilegge row e attempt con lock;
2. verifica owner, token hash, fencing token, lease ed expiry con clock PostgreSQL;
3. riparsa l'envelope N10 chiuso e ricostruisce record hash e campi N11;
4. esegue il callback N13;
5. completa inbox e attempt come `PROCESSED` nella stessa transazione.

Un errore nel callback annulla evidence, Lead, ledger, case, candidate e identity row. La failure
N11 viene registrata soltanto dopo il rollback e secondo la tassonomia chiusa.

## Mapping N10 → Lead

Il mapping crea un Lead soltanto nel ramo automatico con zero candidati o dopo una decisione umana
`CREATE_NEW`. Non aggiorna mai un Lead esistente.

| Campo N10 | Campo Lead | Regola |
| --- | --- | --- |
| `payload.firstName` | `firstName` | valore esatto o stringa vuota |
| `payload.lastName` | `lastName` | valore esatto o stringa vuota |
| `payload.companyName` | `companyName` | valore o `null` |
| — | `contactPerson` | `null` |
| `payload.phone` | `phone` | valore N10 o `null` |
| `payload.email` | `email` | valore N10 canonicalizzato o `null` |
| source N10 | `source` | `N10:<systemCode>:<formCode>:<formVersion>` |
| contratto N10 | `leadSource` | `altro` |
| `payload.region/city` | `region/city` | valore o `null` |
| — | `province` | `null` |
| testi/catalogo | `interest` | service text, interest text, service code, `null` |
| requested amount | `requestedAmount` | minor unit divise per 100 con `Prisma.Decimal` |
| — | altri importi | `null` |
| `payload.message` | `notes` | valore esatto o `null` |
| — | stato/priorità | `nuovo` / `media` |
| — | campi commerciali, assignment e client | `null` |

`sourcePagePath`, privacy reference e catalog metadata rimangono nell'evento/evidence autorevole.
Non vengono copiati in note, audit o telemetria.

## Normalizzazione e identità

La versione unica è `n13-v1`.

| Segnale | Forza | Normalizzazione |
| --- | --- | --- |
| `EMAIL_EXACT_V1` | forte | NFC/trim/whitespace/lowercase; nessuna regola provider |
| `PHONE_E164_EXACT_V1` | forte | rimuove solo spazio ASCII, `.`, `-`, `(`, `)`; E.164 esplicito |
| `PHONE_NATIONAL_EXACT_V1` | debole | stessi separatori; 7–15 cifre; nessuna country inference |
| `PERSON_NAME_EXACT_V1` | debole | nome e cognome entrambi presenti, NFC, trim, collapse, lowercase |
| `COMPANY_NAME_EXACT_V1` | debole | NFC, trim, collapse, lowercase |

Non sono ammessi fuzzy matching, transliteration, alias email, rimozione di `+tag`, country guessing
o finestre temporali. Tutti i Lead con `deletedAt IS NULL` sono eleggibili. La ricerca unisce le
identity row attive al fallback raw conservativo indicizzato, deduplica per Lead e ordina per:

1. presenza di un segnale forte, decrescente;
2. numero complessivo di segnali, decrescente;
3. `Lead.createdAt`, crescente;
4. `Lead.id`, crescente.

Non è presente `LIMIT 1`: l'intero insieme viene snapshotato.

Il digest è HMAC-SHA-256 esadecimale su:

```text
fai.lead-identity.v1
n13-v1
<keyVersion>
<signalKind>
<canonicalValue>
```

Il secret deve essere esattamente di 32 byte e vivere in un file privato direttamente sotto
`/run/secrets`, senza symlink, nel formato chiuso `{version, secretBase64}`. La fingerprint SHA-256
e la versione devono coincidere timing-safe con l'unica row `ACTIVE` del registro N13. Path vuoto,
file non conforme, registro vuoto, più row attive o mismatch falliscono chiusi.

Nessun secret o canonical value viene persistito nelle nuove tabelle. Digest e fingerprint sono
classificati come dati personali o secret-derived e non sono emessi in AuditLog o N06.

## Matrice di projection 0/1/N

Un advisory lock transazionale globale `FAI_LEAD_IDENTITY_WRITE_V1` serializza projector,
risoluzione e creazione Lead manuale protetta.

| Candidati | Risultato atomico |
| ---: | --- |
| 0 | due privacy receipt, nuovo Lead, identity row, ledger `PROJECTED_NEW`, completion N11 |
| 1 | due privacy receipt, ledger `REVIEW_REQUIRED`, case e snapshot; nessuna mutation Lead |
| N | come il caso 1 per tutti i candidati ordinati; nessuna mutation Lead |

Anche un solo match forte richiede una decisione umana. Il vincolo unique su
`LeadProjectionLedger.inboxEventId` è la barriera exactly-once applicativa.

## Privacy evidence

`PrivacyEvidenceReceipt` supporta due binding alternativi e mutuamente esclusivi:

- ramo legacy website: `websiteLeadReceiptId` e `leadId` presenti;
- ramo N13: `businessInboxEventId` presente e `leadId`/`websiteLeadReceiptId` null.

Nel ramo N13 vengono create esattamente due receipt append-only: acknowledgement del servizio e
decisione marketing. Il trigger verifica envelope, payload hash, source metadata, occurredAt,
purpose, legal basis, notice attiva e hash domain-separated
`fai.privacy-evidence.business-inbox.v1`. La receipt resta legata all'evento, non a un Lead
potenzialmente ambiguo. La risoluzione manuale rilegge e verifica entrambe le receipt.

## Persistenza e state machine

La migration 40 è
`20260821160000_lead_projection_normalization_manual_duplicate_resolution_v1`.

Checksum SHA-256 del file SQL qualificato:
`234f574703ec81f7ab0b43c0854a1dab3264c8462e6ccb1f0d0b92f288415c78`.

È una singola transazione additiva e business-empty. Non esegue backfill, seed, projection,
creazione key, update di gate o activation.

| Tabella | Contratto |
| --- | --- |
| `LeadIdentityKeyVersion` | registro `STAGED/ACTIVE/RETIRED/REVOKED`, una sola ACTIVE |
| `LeadIdentityKey` | digest versionato per Lead e source ledger/decision; retirement monotono |
| `LeadProjectionLedger` | unique inbox, state, version, result hash e due evidence |
| `LeadDuplicateCase` | `OPEN/RESOLVED`, revision, candidate count, optimistic version |
| `LeadDuplicateCandidate` | snapshot append-only per case/revision/rank/Lead |
| `LeadDuplicateDecision` | sequenza e hash-chain append-only con actor/session/reason |

Transizioni ledger consentite:

- iniziale `PROJECTED_NEW` oppure `REVIEW_REQUIRED`;
- `REVIEW_REQUIRED → RESOLVED_EXISTING | RESOLVED_NEW`;
- `RESOLVED_EXISTING | RESOLVED_NEW → REVIEW_REQUIRED` soltanto tramite reopen.

Transizioni case consentite:

- iniziale `OPEN`, revision 1, version 1, almeno un candidato;
- `OPEN → RESOLVED`, stessa revision e candidate count;
- `RESOLVED → OPEN`, revision incrementata di uno e nuova discovery anche con zero candidati.

Candidate e decisioni sono append-only. Ledger, case, key version e identity row applicano trigger
di identità, versione e transizione. Delete e truncate sono negati. Tutte le FK business sono
`RESTRICT`, salvo `createdById` della key version che usa `SET NULL`.

## Risoluzione manuale

La server action è esposta dalla vista protetta `/leads/duplicates` introdotta da VNX-01. Gli
outcome ammessi restano soltanto:

- `LINK_EXISTING_NO_OVERWRITE`: il Lead deve appartenere alla revision corrente ed essere attivo;
  nessun suo campo viene aggiornato;
- `CREATE_NEW`: crea un Lead con il mapping N10 e conserva i candidati e la scelta umana;
- `REOPEN`: registra una decisione compensativa, ritira le identity row della decisione precedente,
  rimuove il link corrente dal ledger, riscopre e aggiunge una nuova revision.

Non esistono merge, delete, overwrite, auto-link o riscrittura dello storico. Un Lead creato e poi
riaperto non viene cancellato o alterato e può riapparire come candidato via fallback raw.

Ogni comando richiede `expectedCaseVersion > 0`, `reasonCode` chiuso uppercase e un eventuale
`reasonNote` di massimo 500 caratteri. `selectedLeadId` è obbligatorio soltanto per link existing.

## Authorization e sessione

`lead.duplicate.resolve` è un permesso protetto:

- `admin` e `direzione` sono gli unici ruoli ammessi;
- una override non può concederlo ad altri ruoli;
- una override deny non lo rimuove dai due ruoli protetti;
- l'utente inattivo è sempre negato.

La action applica in ordine:

1. `requirePermission('lead.duplicate.resolve')`;
2. step-up N03 obbligatoriamente in modalità `enforced`;
3. origin allowlisted, key N03 pronta e token step-up valido e session-bound;
4. modalità `INTERNAL_SESSION_MODE=registry` e `sessionId` obbligatorio;
5. validazione schema chiusa;
6. nella stessa transazione serializable, lock e rilettura di sessione, utente, role e override;
7. advisory lock identity, key consensus, case/ledger/inbox/candidate/Lead lock e expected version.

Una revoca di sessione, disattivazione utente, cambio ruolo o conflitto di versione viene
linearizzato dal database. La decisione non si basa soltanto sul cookie già letto dalla action.

## Audit e redazione

Gli eventi automatici hanno actor `null`; le decisioni manuali usano l'actor reale. L'AuditLog
manuale è nella stessa transazione della decisione e ha `entityId = null`.

Il payload consentito contiene soltanto versione risoluzione, outcome, reason code, versioni case e
ledger, discovery revision e candidate count. Non contiene case/ledger/Lead/candidate/session ID,
email, telefono, nome, message, notes, `reasonNote`, envelope, digest, snapshot hash o decision hash.

## Failure matrix

| Condizione | Comportamento |
| --- | --- |
| lease/token/fence/owner/attempt stale | rollback; `BUSINESS_QUEUE_LEASE_STALE`; nessuna failure mutation N13 |
| lease scaduta | rollback; stale; recovery resta ownership N11 |
| envelope, hash, classification o record hash incoerente | rollback; integrity failure; nessuna correzione automatica |
| key file/ACTIVE row assente | rollback; `N13_IDENTITY_KEY_UNAVAILABLE`, retryable N11 |
| key version/fingerprint mismatch | rollback; `N13_IDENTITY_KEY_CONSENSUS_FAILURE`, retryable N11 |
| notice/evidence privacy indisponibile | rollback; `N13_PRIVACY_CONTRACT_UNAVAILABLE`, retryable N11 |
| serialization, deadlock o lock timeout | retry bounded; poi conflitto controllato |
| invariante business impossibile | rollback; `N13_PROJECTION_INVARIANT_FAILURE`, non retryable |
| fault/crash prima del commit | rollback totale; lease/failure/recovery restano N11 |
| commit riuscito e risposta persa | inbox già `PROCESSED` e ledger unique; nessuna seconda projection |
| caso/versione concorrente | un solo winner; loser con version/transaction conflict |
| sessione revocata o ruolo non più ammesso | rollback; `N13_DUPLICATE_SESSION_DENIED` |
| candidato non corrente o soft-deleted | rollback; `N13_DUPLICATE_CANDIDATE_INVALID` |
| identity/notice reali assenti | fail-closed; nessun fallback a dati o chiavi inventate |

## Concorrenza e compatibilità writer

Il lock globale copre la projection, la risoluzione e `createLead`. `createLead` esegue sotto lock
un precheck raw dei soli segnali forti email exact e telefono E.164 exact. Un conflitto blocca la
creazione con errore utente, senza mutazioni parziali. Nome, azienda e telefono nazionale non
provocano un blocco automatico.

N01 legacy resta intenzionalmente invariata e non partecipa al lock N13. Per questo una futura
activation richiede come prerequisito rigido N01 `disabled`. N13 non cambia le semantiche di N01,
N10, N11 o N12.

## Qualificazione

La matrice test N13 copre:

- mapping, normalizzazione, HMAC, parser key e consensus;
- permission non delegabile, mandatory step-up e registry revalidation;
- privacy event-bound e audit minimizzato;
- fresh migration 40 e upgrade esatto 39→40 con stato N12 preservato;
- constraint, FK, partial unique, transition trigger, append-only e deny truncate;
- projection 0/1/N, exactly-once, stale, expiry e replay;
- link non-overwrite, create-new, reopen, retirement e storico;
- optimistic conflict e session revoke interleaving;
- rollback dopo evidence, Lead, ledger, case e prima completion;
- multiprocesso same-inbox, overlapping identity, create/projection e doppia decisione;
- gate Prisma, lint, unit, DB, typecheck, build, Docker smoke, staging read-only e restore/N−1.

I test DB distruttivi accettano soltanto il database loopback `fai_crm_test`, schema pubblico per il
guard iniziale, conferma esplicita e sentinel database-bound
`FAI_CRM_EPHEMERAL_TEST_ONLY_V1`. Le prove N13 usano sottoschemi isolati e dati sintetici con domini
riservati.

## Release futura, separatamente autorizzata

Il merge o il deploy di questo codice non abilita N13. Una futura release richiede un mandato
separato e, almeno:

1. nuovo preflight read-only e conferma esatta commit/tree/artefatto;
2. backup verificato della baseline applicativa e DB39;
3. applicazione della sola migration 40 e verifica checksum/unfinished migration;
4. smoke con key path vuoto, zero key row attive e zero consumer;
5. deploy applicativo dormant e health/read-only checks;
6. autorizzazioni ulteriori per provisioning key, consumer e activation;
7. N01 legacy confermato `disabled` prima di qualsiasi traffico N13;
8. N03 `enforced`, session registry attivo e runbook operatori prima di decisioni manuali.

Questo elenco è un prerequisito, non un'autorizzazione a eseguirlo.

## Rollback

Il rollback applicativo futuro è l'immagine PR106 su DB40: la migration è additiva e il codice
precedente ignora le nuove tabelle e la nuova colonna event-bound. Non è prevista una down-migration
automatica.

Finché N13 resta dormant e senza dati reali, il rollback non richiede cancellazioni business. Dopo
un'eventuale activation futura, evidence, ledger, candidate e decisioni non devono essere cancellati
o riscritti: una correzione usa `REOPEN` e una nuova decisione compensativa. Un restore completo è
un'operazione di emergenza distinta, subordinata a un'autorizzazione esplicita.
