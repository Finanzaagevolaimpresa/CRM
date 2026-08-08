# ADR-0012 — AI Manual Authorization Corrective Lifecycle & Exact Input Hash v1

## Stato

Implementata dalla PR86 come correzione additiva e non operativa della PR85. ADR-0011 resta il documento storico del contratto v1.

## Decisione lifecycle

`NEEDS_INFORMATION` è terminale e immutabile. Non ammette approvazione, cancellazione, scadenza materializzata, revoca, consumo, grant, run o ulteriori eventi ledger. `expiresAt` resta soltanto evidenza storica. Le informazioni integrate vengono presentate esclusivamente mediante una nuova richiesta nel contesto CRM originario.

La nuova richiesta usa `supersedesRequestId`, self-FK `RESTRICT` immutabile e univoca. I flussi diagnostica, agente cliente e quick-run riportano il richiedente al contesto CRM originario; l'azione server non si fida del parametro UI e blocca la sorgente in transazione serializable. Servizio e database richiedono `NEEDS_INFORMATION`, assenza di grant/run o successore e continuità di origine, richiedente, funzione, finalità e riferimenti CRM. ID, correlation ID, idempotency key, fingerprint, exact-input hash, genesis ledger, audit e notifiche sono nuovi. Provider, modello e snapshot agente possono cambiare, ma entrano nel nuovo binding.

## Decisione hash

Le funzioni globali `canonicalJson`, `canonicalSha256`, `createAiRequestFingerprint` e `canonicalize_ai_workflow_jsonb` conservano la semantica v1. Il solo gate di autorizzazione usa il contratto dedicato v2:

- dominio JSON/I-JSON con numeri finiti IEEE-754 binary64;
- rappresentazione numerica ECMAScript, incluso `-0` come `0`;
- ordinamento delle chiavi per unità UTF-16;
- array ordinati, stringhe JSON senza normalizzazione Unicode;
- UTF-8 e SHA-256 lowercase;
- preimage domain-separated `{ "hashCanonicalizationVersion": 2, "value": ... }`.

La versione vincola fingerprint e exact-input hash ed è persistita e verificata su richiesta, grant, `grantHash`, `AiRun` e permit. Versioni assenti per un binding v2, sconosciute o discordanti falliscono chiuse. Le righe PR85 ricevono versione 1 senza ricalcolo; gli `AiRun` storici restano `NULL`. Solo un insert PR85 legato a request e grant entrambi v1 materializza `AiRun.hashCanonicalizationVersion=1`.

## Compatibilità e rollback

DB31 precede sempre app PR86. App PR86 contro DB30 fallisce perché il contratto versionato non esiste. App PR85 può creare e consumare binding v1 su DB31; non può consumare binding v2. Il rollback applicativo PR86→PR85 è vietato quando `assert_ai_execution_pr85_rollback_safe_v2()` fallisce: ciò include righe v2, sostituzioni o qualsiasi `NEEDS_INFORMATION`, anche con scadenza futura, perché il lazy expiration PR85 tenterebbe successivamente di aggiungere `EXPIRED` al ledger terminale. Non esiste down migration distruttiva.

## Invarianti operative

La migration non crea richieste, grant, notifiche, job o run e non ricalcola dati. Restano `stateMachineEnabled=false`, `dispatchEnabled=false`, `syntheticDataOnly=true`, provider `mock`, provider esterni e tutte le capability worker disabilitati. Non sono introdotti worker, scheduler, cron, consumer, dispatch o esecuzione AI.
