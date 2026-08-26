# ADR-0013 — N15 Communication Intent Contract-Only Foundation v1

## Stato

Accettata per N15 Phase 1A. La decisione autorizza esclusivamente primitive TypeScript pure,
documentazione e un mock unit-test-only. Non autorizza persistenza, trasporto, delivery, deploy o
activation.

## Contesto

N11 implementa un durable inbox/outbox specifico per `fai.lead-event.v1` e `LEAD_SUBMITTED`.
`BusinessOutboxEvent` è legato al receipt inbound e alla projection lead; non è una coda generica
per comunicazioni. N12 resta il gateway inbound lead, N13 governa projection e identità lead, N14
governa attribution e SLA commerciali. `PracticeCommunication` resta un record editoriale/manuale
e non prova recipient, policy, dispatch o delivery.

Riutilizzare una di queste superfici senza una decisione di persistenza separata mescolerebbe
ownership e invarianti incompatibili.

## Decisione Phase 1A

La Cabina approva lo Scenario B minimo con le seguenti decisioni:

1. soltanto intenti outbound; nessun inbound;
2. classi chiuse `TRANSACTIONAL`, `SERVICE`, `SECURITY`; marketing escluso;
3. recipient come riferimento esatto a un'entità CRM, senza snapshot di email, telefono, PEC,
   indirizzo o endpoint;
4. idempotenza ibrida: chiave caller normalizzata e non restituita, digest della chiave,
   `semanticHash` canonico ed `envelopeHash` separati per dominio;
5. audit costruito per allowlist con soli riferimenti hashati, hash e reason code chiusi; il
   reason reference del caller è hashato e non copiato; nessun body, recapito, secret o errore
   libero;
6. gate gerarchici `CAPABILITY`, `WORKER`, `DISPATCH`, `EGRESS`, `CHANNEL`, `PROVIDER`, `TENANT`
   con regola all-of, default tutti disabilitati e comportamento fail-closed;
7. stati concettuali limitati a `RECORDED` e `HELD`; unica transizione ammessa
   `RECORDED -> HELD`.

Anche se un test costruisce il vettore astratto all-enabled, Phase 1A produce sempre `HELD` con
`N15_PHASE1A_DORMANT`. Il contratto non espone alcuno stato `READY`, `SENT` o `DELIVERED`.

## Ownership e confini

- N15 possiede il contratto semantico e le sole primitive pure introdotte da questa ADR.
- N11 non viene importato, modificato, popolato o adattato.
- N12, N13, N14 e `PracticeCommunication` restano invariati e non sono call-site N15.
- N04 classifica i nuovi campi con purpose `N15_PHASE1A_UNASSIGNED` e marker
  `DPO_VALIDATION_REQUIRED`, senza assegnare una base giuridica; N06 resta invariato perché Phase
  1A non emette telemetria.
- Il tenant gate non inventa `tenantId`: il repository non contiene ancora un modello tenant o
  workspace approvato.
- Il mock vive soltanto in `tests/fixtures`; non entra nel codice runtime copiato nell'immagine.

## Decisioni differite

Restano fuori da questa ADR: canali, provider, resolver recipient, base giuridica/consenso,
opt-out, retention, template registry operativo, ordering, TTL, retry/backoff, DLQ/replay,
webhook, secret, budget/rate limit, SLO, RPO/RTO e scelta della persistenza. Qualunque soluzione
tra generalizzazione N11, primitive comuni o storage N15 dedicato richiede un'ADR e un mandato
separati.

## Conseguenze e rollback

Phase 1A non introduce route, action, producer, consumer, worker, scheduler, cron, adapter,
provider, rete, configurazione, modello Prisma o migration. Il rollback è il revert applicativo
dei file N15 e delle sole classificazioni N04 aggiunte; non esistono dati da riparare né rollback
database. La registrazione di un intento resta concettuale e non implica autorizzazione alla
consegna.
