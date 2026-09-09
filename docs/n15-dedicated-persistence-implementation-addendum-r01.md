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

`runCommunicationPersistenceTransactionV1` apre una sola transazione Prisma per il callback del
chiamante. La causa business usa `scope.client`; `recordCommunicationIntentHeldV1` accetta soltanto
lo scope attivo creato da quel confine, mai un normale PrismaClient, un TransactionClient esterno
o uno scope scaduto. Il chiamante conserva la decisione di completare o annullare il proprio
callback, senza transazioni annidate né dual-write/best-effort.

Ogni errore dell'operazione N15 invalida lo scope: anche se il callback lo intercetta, il confine
rilancia l'errore prima del commit, annullando intento, decisione, audit e causa. Alla fine del
callback verifica inoltre il constraint differito mentre il callback Prisma è ancora attivo.
Questo rende osservabile l'errore prima della fase di commit del motore Prisma 5.22.
Gli errori del callback business restano originali: la traduzione in N15_SCHEMA_UNAVAILABLE
è circoscritta alle operazioni N15 e alla verifica finale del suo vincolo.

Il constraint trigger PostgreSQL differito impedisce comunque la conferma di un aggregate
incompleto. Usa lo schema della tabella che lo ha attivato, senza dipendere dal search path del
chiamante. Foreign key, unique dei figli e trigger append-only conservano l'aggregate completo;
trigger per istruzione rifiutano TRUNCATE su tutte e tre le tabelle. Il producer e i due istanti provengono da un oggetto di autorità interna creato dal
composition boundary, non dai valori business del caller. In R01 tale autorità è qualificata
esclusivamente dalle fixture; non esistono producer o call-site applicativi.

La unique sul digest della chiave serializza anche writer concorrenti. Stessa chiave e stessa
semantica restituiscono l'aggregate originario (inclusi `intentId`, byte canonici e hash); stessa
chiave e semantica diversa restituiscono `N15_IDEMPOTENCY_CONFLICT` senza scritture. Un `intentId`
già associato a un aggregate divergente produce lo stesso conflitto. Chiavi differenti possono
invece registrare la stessa semantica. Ogni replay ricalcola e verifica envelope, decisione, audit e
relativi hash; righe mancanti o incoerenti falliscono chiuso. Il replay confronta inoltre producer,
occurredAt, evaluatedAt e i riferimenti dei figli al record radice con l'aggregate canonico. I campi
createdAt rimangono metadati di inserimento generati dal database, distinti dai tempi del contratto.

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
