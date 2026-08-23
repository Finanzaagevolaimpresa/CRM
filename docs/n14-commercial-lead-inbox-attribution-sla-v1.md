# N14 — Commercial Lead Inbox, Attribution & SLA v1

## Stato

N14 introduce una foundation dormiente sopra `Lead`. Non crea policy, item, cicli o activity e
non attiva traffico, worker, consumer, timer o comunicazioni.

`COMMERCIAL_LEAD_INBOX_MODE` accetta soltanto `enforced`; qualsiasi altro valore, incluso assente,
vuoto o sconosciuto, equivale a `disabled`. Anche in `enforced`, un enrollment richiede una policy
`COMMERCIAL_FIRST_RESPONSE` ACTIVE creata da un futuro mandato di activation.

## Confine dati

`Lead` resta l'unica anagrafica e conserva l'owner in `assignedToId`. N14 aggiunge:

- un item inbox univoco e un'attribution immutabile `n14-v1`;
- policy SLA versionate, senza valori predefiniti;
- cicli first-response continui 24x7 UTC basati sul clock PostgreSQL;
- activity append-only senza testo libero o payload.

Le origini ammesse sono `MANUAL_CRM`, `WEBSITE_LEGACY_N01`, `BUSINESS_PROJECTION_N13` e
`LEGACY_UNVERIFIED`. I binding N01/N13 devono provare lo stesso Lead; nessuna origine viene inferita
da email, URL, testo libero o campi legacy.

## Lifecycle

Initialize crea atomicamente item OPEN, ciclo 1 e activity. Claim/assign/unassign cambiano soltanto
`Lead.assignedToId`. First response chiude l'obiettivo del ciclo con `MET` o `BREACHED`. Close
chiude item e ciclo; reopen è privilegiato e apre un nuovo ciclo sulla policy ACTIVE corrente.
La conversione richiede owner corrente e prima risposta già registrata, quindi crea il Client e
chiude Lead, item e ciclo come `CONVERTED` nella stessa transazione.

Il servizio acquisisce nell'ordine clock database, sessione/actor, Lead, item e ciclo/policy, poi
rivalida permessi e versioni dentro la transazione. Il guard PostgreSQL impedisce modifiche dirette a source, owner o stati
terminali quando esiste un item N14.

## SLA

`availableAt` è il clock database dell'enrollment, non il timestamp storico dell'origine.
`dueAt = availableAt + responseTargetSeconds`. `OVERDUE` è derivato in lettura e non produce
scritture. V1 non applica business hours, pause o festività.

## Sicurezza e privacy

La lettura riusa `lead.read`; self-claim richiede `lead.inbox.claim`; assign, unassign, reopen e
legacy enrollment richiedono `lead.inbox.assign`, ruolo admin/direzione, privileged access
enforced, registry session viva e step-up valido. Activity e AuditLog contengono soltanto codici,
stati e versioni. Retention resta `N21_UNASSIGNED` con eligibility nulla.

## Release e rollback

Migration 42 è additiva, transazionale e business-empty. La qualificazione richiede fresh42,
upgrade esatto 41→42, zero righe, smoke Docker e PR108 N−1 su DB42. Il rollback è soltanto
applicativo a PR108 su DB42; nessuna down-migration o restore reale è implicita.

Identità qualificata:

- migration `20260823160000_commercial_lead_inbox_attribution_sla_v1`;
- SHA256 `b592c9a0f9b98e95924f35a863b59d6bcf8f36cecc75c8c7daa35fff7aa0b666`;
- catalogo esatto: 4 tabelle, 25 indici, 9 trigger e 5 funzioni N14;
- stato di rilascio: 42 migration concluse, 0 incomplete e 0 righe N14.
