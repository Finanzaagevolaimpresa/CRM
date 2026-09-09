# N15 — Addendum di implementazione della persistenza dedicata R01

Stato: **foundation dormiente implementata; nessuna attivazione applicativa**. Questo addendum
implementa il confine futuro approvato da ADR-0014 senza modificare retroattivamente l'ADR o le
descrizioni storiche delle migrazioni.

## Decisioni circoscritte

- Lo storage assume **una sola organizzazione per database dedicato**. Le chiavi uniche valgono
  nell'intero database; non viene introdotto `tenantId` e non viene promesso isolamento
  multi-organizzazione. Un uso multi-organizzazione richiede una decisione distinta prima di dati
  reali.
- `CommunicationIntentRecord` conserva l'intento immutabile `RECORDED`;
  `CommunicationHeldDecision` conserva la decisione terminale separata `HELD`;
  `CommunicationIntentAudit` conserva soltanto l'audit minimizzato del contratto Phase 1A.
- Le tabelle non contengono destinatari reali, endpoint, body, provider o informazioni di dispatch.
  Non riusano `BusinessInboxEvent`, `BusinessOutboxEvent`, `BusinessQueueAttempt`,
  `PracticeCommunication` o `AuditLog`; N11 rimane invariato.
- La migrazione 44 è additiva, transazionale e priva di righe business. Le prime 43 migrazioni e gli
  scenari di recovery fissati a quella baseline rimangono byte-identici.

## Atomicità, autorità e idempotenza

`recordCommunicationIntentHeldV1` riceve obbligatoriamente un `Prisma.TransactionClient`: il
chiamante decide commit o rollback e non esiste un percorso dual-write/best-effort. Intento,
decisione e audit, nonché ogni causa sintetica scritta dal chiamante, appartengono quindi alla stessa
transazione. Il producer e i due istanti provengono da un oggetto di autorità interna creato dal
composition boundary, non dai valori business del caller. In R01 tale autorità è qualificata
esclusivamente dalle fixture; non esistono producer o call-site applicativi.

La unique sul digest della chiave serializza anche writer concorrenti. Stessa chiave e stessa
semantica restituiscono l'aggregate originario (inclusi `intentId`, byte canonici e hash); stessa
chiave e semantica diversa restituiscono `N15_IDEMPOTENCY_CONFLICT` senza scritture. Un `intentId`
già associato a un aggregate divergente produce lo stesso conflitto. Chiavi differenti possono
invece registrare la stessa semantica. Ogni replay ricalcola e verifica envelope, decisione, audit e
relativi hash; righe mancanti o incoerenti falliscono chiuso.

## Compatibilità e rollback

Il drill Docker N05 costruisce l'immagine candidata, conserva il database a 44 migrazioni, verifica
health e tabelle N15 vuote, quindi sostituisce realmente l'app con un'immagine costruita dalla base
N−1 e ripete health e inerzia N15. La ricevuta vincola commit, tree, image ID e conteggi schema.
Separatamente, la nuova API contro lo schema a 43 migrazioni
fallisce esplicitamente con `N15_SCHEMA_UNAVAILABLE` e non ripiega su N11 o su un altro storage.
Il rollback applicativo consiste nel distribuire nuovamente la versione N−1 lasciando schema e righe
intatti. Non è prevista né autorizzata una down migration distruttiva.

Restano spenti worker, cron, scheduler, dispatch, egress, canali e provider. Purpose, base giuridica,
retention e permessi business richiedono qualifica separata prima di dati reali o attivazione.
