# Produzione CRM FAI

Questa guida prepara il CRM FAI a un deploy production-ready senza introdurre servizi esterni obbligatori. Non contiene segreti reali: usare solo valori generati e custoditi nel server o nel secret manager scelto.

## Prerequisiti server

- Linux server aggiornato con accesso SSH amministrativo.
- Node.js 22 LTS o runtime compatibile con Next.js 15.
- npm coerente con `package-lock.json`.
- PostgreSQL raggiungibile dall'applicazione su rete privata.
- `pg_dump` e `pg_restore` installati per backup e restore.
- Reverse proxy come Nginx, Caddy o Traefik davanti a Next.js.
- Certificato TLS valido: HTTPS è obbligatorio in produzione.
- Directory persistente e non pubblica per documenti locali, ad esempio `/var/lib/fai-crm/documents`.

## Variabili ambiente

Partire da `.env.production.example`, copiarlo fuori dal repository e sostituire ogni placeholder.

Variabili principali:

- `DATABASE_URL`: connessione PostgreSQL privata. Non esporre il database su Internet.
- `APP_ENV=production` e `NODE_ENV=production`.
- `NEXT_PUBLIC_APP_URL`: URL pubblico HTTPS del CRM, ad esempio `https://crm.example.com`.
- `AUTH_COOKIE_NAME`: nome cookie applicativo.
- `AUTH_SECRET`: segreto forte, casuale, lungo almeno 32 byte. Non riusare valori development.
- `STORAGE_PROVIDER=local`: provider runtime attualmente supportato.
- `LOCAL_DOCUMENT_STORAGE_ROOT`: directory persistente non servita direttamente dal web server.
- `AI_PROVIDER`: compatibilità/diagnostica; lasciare `mock`. I run operativi usano provider e modello configurati sul singolo agente.
- `AI_API_KEY`: solo server-side e solo se richiesta dal provider AI configurato. Non creare variabili `NEXT_PUBLIC_*` per questa chiave.
- `AI_EXTERNAL_PROVIDERS_ENABLED=false`: gate infrastrutturale globale. Solo il valore esatto `true` consente di valutare provider esterni.
- `AI_ALLOWED_MODELS=""`: allowlist CSV dei modelli esterni; vuota significa nessun modello autorizzato.
- `WEBSITE_LEAD_WEBHOOK_SECRET`: segreto lungo per l'endpoint lead WordPress, se usato.

Le variabili S3 in `.env.production.example` sono placeholder coerenti con la configurazione prevista, ma il runtime attuale documenta `local` come provider operativo. Non impostare `STORAGE_PROVIDER=s3` finché l'implementazione S3 non è completata e collaudata.

### Provider AI esterni

Il deploy nasce fail-closed. Una chiamata esterna richiede contemporaneamente il gate `AI_EXTERNAL_PROVIDERS_ENABLED=true`, lo switch globale nel database, un modello presente nella allowlist non vuota, i permessi `ai.run` e `ai.external.run` e la conferma dell'operatore. Disattivare il gate ambiente o lo switch database blocca nuove chiamate esterne.

Staging e produzione devono usare progetti OpenAI, chiavi, budget, allowlist e switch database distinti. Non copiare la chiave fra ambienti e non inserire mai chiavi in Git, nel database, nei prompt, nei log o in variabili `NEXT_PUBLIC_*`. Il runtime usa `store: false`, ma non presume Zero Data Retention: i controlli ZDR/Modified Abuse Monitoring richiedono idoneità e configurazioni OpenAI separate. Vedere [`docs/ai-control-plane.md`](ai-control-plane.md) prima dell'attivazione.

## Installazione e build produzione

```bash
npm ci
npm run prisma:generate
npm run build
```

`npm ci` usa il lockfile e deve essere preferito in CI/CD e server production.

## Prisma

Generare sempre il client Prisma prima della build:

```bash
npm run prisma:generate
```

Applicare migration solo se la directory `prisma/migrations` contiene migration committate e approvate:

```bash
npm run prisma:migrate:deploy
```

Non usare `prisma migrate dev` in produzione e non generare migration direttamente sul server.

## Avvio applicazione

Esempio con systemd o process manager equivalente:

```bash
npm run start
```

Il processo Next.js deve ascoltare solo su interfaccia privata o localhost; il traffico pubblico deve passare dal reverse proxy HTTPS.

## Reverse proxy e HTTPS

Esempio Nginx minimale:

```nginx
server {
  listen 443 ssl http2;
  server_name crm.example.com;

  ssl_certificate /etc/letsencrypt/live/crm.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/crm.example.com/privkey.pem;

  client_max_body_size 25m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

Reindirizzare tutto il traffico HTTP verso HTTPS. In produzione i cookie di sessione sono `httpOnly` e `secure` quando `NODE_ENV=production`.

## Storage documenti

- Usare una directory persistente, privata e con permessi restrittivi.
- Non servire `LOCAL_DOCUMENT_STORAGE_ROOT` come static file dal reverse proxy.
- Upload e download devono passare dalle route applicative protette da login e permessi.
- Includere la directory documenti nei backup.

## Backup e restore base

Script non distruttivo disponibile:

```bash
DATABASE_URL="$DATABASE_URL" LOCAL_DOCUMENT_STORAGE_ROOT="/var/lib/fai-crm/documents" ./scripts/backup-local.sh
```

Produce un dump PostgreSQL custom e un archivio tar.gz dei documenti se la directory esiste. I backup contengono dati clienti e documenti riservati: conservarli cifrati o in storage protetto, non lasciarli in cartelle pubbliche/condivise e limitare i permessi di accesso agli amministratori autorizzati.

Se `LOCAL_DOCUMENT_STORAGE_ROOT` non esiste, lo script mostra un warning pulito, non interrompe il backup database già completato e salta solo l'archivio documenti.

Restore database su database vuoto/preparato:

```bash
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" ./backups/postgres-YYYYMMDDTHHMMSSZ.dump
```

Restore documenti:

```bash
mkdir -p /var/lib/fai-crm/documents
tar -xzf ./backups/documents-YYYYMMDDTHHMMSSZ.tar.gz -C /var/lib/fai-crm/documents
```

Prima di restore in produzione fermare l'applicazione, verificare di avere un backup recente e validare il piano su ambiente staging. Testare periodicamente il restore database/documenti per confermare che i backup siano realmente utilizzabili.

## Health check

`GET /api/health` restituisce solo informazioni non sensibili: stato applicativo, raggiungibilità database e timestamp. Non espone segreti, connection string o dati cliente.

## Checklist sicurezza produzione

- [ ] `AUTH_SECRET` forte, casuale e custodito fuori dal repository.
- [ ] Cookie sessione verificati come `httpOnly`; `secure` attivo con `NODE_ENV=production`.
- [ ] HTTPS obbligatorio con redirect da HTTP.
- [ ] Database PostgreSQL non esposto pubblicamente.
- [ ] Upload/download documenti protetti da autenticazione e permessi.
- [ ] Directory documenti privata, persistente e non servita come static asset.
- [ ] Permessi admin verificati; credenziali demo development non presenti in produzione.
- [ ] `AI_API_KEY` solo server-side, mai `NEXT_PUBLIC_*`.
- [ ] `AI_EXTERNAL_PROVIDERS_ENABLED=false` e `AI_ALLOWED_MODELS=""` fino al collaudo e all'approvazione esplicita.
- [ ] Progetto e chiave OpenAI di produzione distinti da staging; budget e limiti configurati.
- [ ] Doppio kill switch AI verificato, `ai.external.run` assegnato con minimo privilegio e test fail-closed superati.
- [ ] Confermato che gli output AI restano bozze revisionate e non generano invii automatici.
- [ ] Backup database e documenti pianificati, cifrati e testati con restore.
- [ ] Log applicativi e audit log consultabili dagli utenti autorizzati.
- [ ] `/api/health` monitorato senza esporre dati sensibili.

## Primo collaudo post-deploy

1. Aprire `https://<dominio>/api/health` e verificare `ok: true` e `database.reachable: true`.
2. Accedere a `/login` con un utente reale di produzione.
3. Verificare dashboard, ricerca globale e notifiche.
4. Caricare un documento di test e scaricarlo da un utente con permesso adeguato.
5. Verificare che un utente senza permessi admin non acceda alle impostazioni riservate.
6. Consultare audit log dopo login, upload/download e azioni principali.
7. Eseguire un backup manuale e controllare che i file siano creati nella destinazione attesa.
8. Confermare che `.env.production.example` e la documentazione non contengano segreti reali.

## Deploy con Docker Compose

Questa repository include esempi separati per il deploy su VPS senza sovrascrivere il flusso di sviluppo locale:

- `Dockerfile.prod.example`: build production Next.js con `npm ci`, `npm run prisma:generate`, `npm run build` e avvio con `npm run start`.
- `docker-compose.prod.example.yml`: stack con app CRM, PostgreSQL, volume database persistente e volume documenti locale persistente.
- `Caddyfile.example`: reverse proxy HTTPS automatico verso l'app in ascolto su `127.0.0.1:3000`.

Preparazione iniziale sul server:

```bash
cp .env.production.example .env.production
```

Modificare `.env.production` solo sul server e non committarlo. Per lo stack Compose, impostare almeno:

```env
DATABASE_URL="postgresql://fai_crm:<db_password>@postgres:5432/fai_crm?schema=public"
POSTGRES_DB="fai_crm"
POSTGRES_USER="fai_crm"
POSTGRES_PASSWORD="<generate-a-strong-database-password>"
AUTH_SECRET="<generate-a-long-random-secret-at-least-32-bytes>"
NEXT_PUBLIC_APP_URL="https://desk.finanzaagevolaimpresa.it"
STORAGE_PROVIDER="local"
LOCAL_DOCUMENT_STORAGE_ROOT="/var/lib/fai-crm/documents"
AI_EXTERNAL_PROVIDERS_ENABLED="false"
AI_ALLOWED_MODELS=""
```

I valori sopra sono placeholder: sostituire password e segreti con valori forti generati sul server. Non inserire `DATABASE_URL`, `AUTH_SECRET`, chiavi S3, `AI_API_KEY` o password reali nel repository.

Build e avvio:

```bash
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml build
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml up -d
```

Il Dockerfile esegue già `npm run prisma:generate` durante la build. Applicare le migration solo se esistono migration committate in `prisma/migrations`:

```bash
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml exec app npm run prisma:migrate:deploy
```

Non usare `prisma migrate dev` in produzione e non generare nuove migration dal server.

## Reverse proxy HTTPS con Caddy

Il file `Caddyfile.example` configura il dominio di esempio `desk.finanzaagevolaimpresa.it` e inoltra il traffico all'app CRM su `127.0.0.1:3000`. Caddy può ottenere e rinnovare automaticamente i certificati TLS quando:

- il record DNS punta già all'IP pubblico della VPS;
- le porte 80 e 443 sono aperte verso la VPS;
- nessun altro processo occupa le porte 80/443;
- l'app Compose espone Next.js solo su localhost tramite `127.0.0.1:3000:3000`.

Esempio di installazione del Caddyfile sul server:

```bash
sudo cp Caddyfile.example /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Non configurare Caddy per servire direttamente la directory `LOCAL_DOCUMENT_STORAGE_ROOT`: upload e download dei documenti devono passare dalle route applicative protette.

## DNS sottodominio

Per pubblicare il CRM sul sottodominio di esempio:

1. Nel pannello DNS del dominio creare un record `A` per `desk.finanzaagevolaimpresa.it` verso l'IP pubblico della VPS.
2. Non inserire IP inventati nella documentazione o nel repository: usare l'IP reale solo nel pannello DNS del provider.
3. Attendere la propagazione DNS prima di richiedere o validare HTTPS.
4. Verificare la risoluzione dal server o dalla propria postazione:

```bash
dig +short desk.finanzaagevolaimpresa.it
```

Avviare Caddy/HTTPS solo dopo che il DNS restituisce l'IP corretto della VPS; in caso contrario l'emissione automatica del certificato può fallire.

## Volumi persistenti

Lo stack Compose usa due volumi Docker nominati:

- `postgres_data`: contiene i dati PostgreSQL e non deve essere eliminato durante deploy ordinari.
- `crm_documents`: contiene i documenti caricati quando `STORAGE_PROVIDER=local` e `LOCAL_DOCUMENT_STORAGE_ROOT=/var/lib/fai-crm/documents` dentro il container.

Prima di qualsiasi operazione distruttiva (`down -v`, rimozione volumi, reinstallazione host), eseguire e verificare un backup completo di database e documenti. Un normale aggiornamento applicativo dovrebbe usare `docker compose up -d --build` senza rimuovere i volumi.

## Backup database e documenti in Docker

Esempio backup database dal servizio PostgreSQL:

```bash
mkdir -p backups
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner \
  > backups/postgres-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Esempio backup volume documenti:

```bash
docker run --rm \
  -v crm_crm_documents:/documents:ro \
  -v "$PWD/backups:/backups" \
  alpine tar -czf /backups/documents-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /documents .
```

Il nome effettivo del volume può includere il prefisso del progetto Compose. Verificarlo con:

```bash
docker volume ls
```

Conservare i backup cifrati o in storage protetto, perché contengono dati clienti e documenti riservati. Testare periodicamente restore database e documenti in staging prima di affidarsi al piano di backup.

## Checklist primo deploy Docker

- [ ] Copiare `.env.production.example` in `.env.production` sul server.
- [ ] Compilare `AUTH_SECRET` con un valore forte, casuale e lungo almeno 32 byte.
- [ ] Configurare `DATABASE_URL` verso il servizio `postgres` dello stack Compose o verso un database privato equivalente.
- [ ] Configurare `POSTGRES_DB`, `POSTGRES_USER` e `POSTGRES_PASSWORD` se si usa il PostgreSQL incluso nel Compose.
- [ ] Configurare `STORAGE_PROVIDER=local`.
- [ ] Configurare `LOCAL_DOCUMENT_STORAGE_ROOT=/var/lib/fai-crm/documents` per usare il volume persistente documenti del Compose.
- [ ] Verificare il record DNS `A` di `desk.finanzaagevolaimpresa.it` verso l'IP VPS e attendere propagazione.
- [ ] Eseguire `docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml build`.
- [ ] Eseguire `docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml up -d`.
- [ ] Confermare che `npm run prisma:generate` sia stato eseguito nel build Docker.
- [ ] Eseguire `npm run prisma:migrate:deploy` nel container app solo se esistono migration committate.
- [ ] Testare `https://desk.finanzaagevolaimpresa.it/api/health`.
- [ ] Testare login admin con un utente reale di produzione.
- [ ] Testare upload e download di un documento.
- [ ] Testare `/settings/system` con un utente autorizzato.
- [ ] Eseguire un backup manuale di database e documenti e verificare che i file siano stati creati.
- [ ] Verificare che repository, file example e documentazione non contengano segreti reali.

## Rollback base

Per un rollback applicativo semplice:

1. Identificare il tag immagine o il commit precedente funzionante.
2. Eseguire un backup prima del rollback, anche se il problema sembra solo applicativo.
3. Ricostruire o ripuntare l'immagine alla versione precedente.
4. Riavviare lo stack senza rimuovere volumi persistenti:

```bash
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml up -d --build
```

5. Non eseguire `docker compose down -v` durante un rollback ordinario: eliminerebbe i volumi di database e documenti.
6. Verificare `/api/health`, login admin, upload/download documenti e `/settings/system` dopo il rollback.

Se una migration già applicata ha modificato il database, non improvvisare downgrade manuali in produzione: ripristinare da backup validato oppure preparare una procedura di rollback dati testata in staging.


## Deploy permessi granulari utente

Prima di applicare la release dei permessi granulari eseguire un backup del database production. Applicare la migration additiva con `prisma migrate deploy`: non sono previsti seed demo, backfill inventati o logout obbligatori. Le eccezioni personali inherit/allow/deny sono effettive immediatamente perché la sessione rilegge ruolo, stato e override dal database. Dopo il deploy verificare il numero di admin attivi e mantenere almeno un amministratore attivo.

## Sequenza Docker production sicura

Eseguire i comandi dalla root del repository sul server. `.env.production` deve restare solo sul server; `.dockerignore` esclude `.env`, `.env.*`, backup, upload e storage privato dal contesto Docker, mantenendo disponibile solo `.env.production.example`.

1. **Build immagine**

```bash
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml build
```

2. **Avvio solo PostgreSQL**

```bash
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml up -d postgres
```

3. **Migration Prisma production**

```bash
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml run --rm app npm run prisma:migrate:deploy
```

Questo usa `prisma migrate deploy`; non usare `prisma migrate dev` in produzione e non eseguire migration durante la build Docker.

Smoke test Docker completo: eseguirlo solo in CI o in un ambiente effimero, mai sul progetto Compose production e mai con `.env.production`. Lo script crea un project name `fai-crm-smoke-*`, un env file temporaneo, un tag immagine temporaneo e distrugge esclusivamente le risorse isolate create dal test. Fallisce se rileva il project name `fai-crm` o una `.env.production` reale.

Verifiche manuali non distruttive sulla VPS production:

```bash
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml config --quiet
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml run --rm app npm run --silent ai:reconcile
```

4. **Seed production-safe**

```bash
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml run --rm app npm run prisma:seed:production
```

Il seed production inizializza solo catalogo servizi e configurazioni agenti AI. Non crea utenti demo, clienti demo, lead demo, documenti demo, pratiche demo o password `ChangeMe123!`.

5. **Primo amministratore**

```bash
BOOTSTRAP_ADMIN_EMAIL="admin@example.com" \
BOOTSTRAP_ADMIN_NAME="Admin CRM" \
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml run --rm app npm run admin:bootstrap
```

Se `BOOTSTRAP_ADMIN_PASSWORD` non è impostata, lo script genera una password forte casuale e la mostra una sola volta nel terminale: salvarla subito in un password manager. Lo script rifiuta di creare un secondo admin attivo; usare `BOOTSTRAP_ADMIN_ALLOW_ADDITIONAL=true` solo se si intende esplicitamente aggiungere un altro amministratore.

6. **Avvio app**

```bash
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml up -d app
```

Il container crea `/var/lib/fai-crm/documents` prima del cambio utente e monta il volume Compose del progetto `fai-crm` su quella directory privata. La directory non deve essere servita da Caddy, Nginx o altri static file server.

7. **Health check**

```bash
curl -fsS https://desk.finanzaagevolaimpresa.it/api/health
```

Verificare `ok: true` e database raggiungibile prima di aprire l'accesso agli utenti.

8. **DNS**

Configurare un record `A`/`AAAA` del dominio CRM verso l'IP pubblico della VPS. Attendere la propagazione prima di chiedere certificati TLS automatici.

9. **Caddy**

```bash
sudo cp Caddyfile.example /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy deve inoltrare verso `127.0.0.1:3000`; il volume documenti resta accessibile solo all'applicazione.

10. **Backup Docker production**

```bash
./scripts/backup-docker-prod.sh
```

Lo script usa `umask 077`, crea la directory backup con permessi `700`, produce dump PostgreSQL custom leggendo `POSTGRES_USER` e `POSTGRES_DB` dentro il container PostgreSQL, archivia i documenti da `/var/lib/fai-crm/documents` tramite il servizio app e crea file con permessi `600`. Non stampa password o `DATABASE_URL` e applica retention configurabile con `RETENTION_DAYS` (default 14). Se la directory documenti non esiste o non è accessibile, conserva il backup database, stampa un warning ed esce con codice `2`; non usa comandi distruttivi come `docker compose down -v`.

Variabili utili:

```bash
COMPOSE_PROJECT_NAME=fai-crm BACKUP_DIR=/secure/backups/fai-crm RETENTION_DAYS=30 ./scripts/backup-docker-prod.sh
```

Restore database su database vuoto/preparato:

```bash
cat /secure/backups/fai-crm/postgres-YYYYMMDDTHHMMSSZ.dump | \
  docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml exec -T postgres \
  sh -c 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Restore documenti:

```bash
cat /secure/backups/fai-crm/documents-YYYYMMDDTHHMMSSZ.tar.gz | \
  docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml exec -T app \
  sh -c 'mkdir -p /var/lib/fai-crm/documents && tar -xzf - -C /var/lib/fai-crm/documents'
```

Cron giornaliero esempio:

```cron
15 2 * * * cd /srv/fai-crm && COMPOSE_PROJECT_NAME=fai-crm BACKUP_DIR=/secure/backups/fai-crm RETENTION_DAYS=30 ./scripts/backup-docker-prod.sh >> /var/log/fai-crm-backup.log 2>&1
```

## Scheduler systemd per AI reconciler

Il reconciler AI deve essere pianificato sul VPS production per chiudere localmente le lease scadute senza invocare provider AI e senza retry verso provider esterni. Gli esempi versionati sono:

- `deploy/systemd/fai-crm-ai-reconcile.service.example`
- `deploy/systemd/fai-crm-ai-reconcile.timer.example`

Installazione manuale sul server, dalla root del repository in `/opt/fai-crm`.

Il file service usa come esempio `User=faiadmin` e `Group=faiadmin`. Prima di abilitarlo verificare che l'account esista e sia autorizzato a usare Docker. Su server con un diverso account di deploy, sostituire `User=` e `Group=` con i valori corretti.

```bash
id faiadmin
getent group docker

sudo cp deploy/systemd/fai-crm-ai-reconcile.service.example /etc/systemd/system/fai-crm-ai-reconcile.service
sudo cp deploy/systemd/fai-crm-ai-reconcile.timer.example /etc/systemd/system/fai-crm-ai-reconcile.timer

sudoedit /etc/systemd/system/fai-crm-ai-reconcile.service
grep -E '^(User|Group|SupplementaryGroups)=' /etc/systemd/system/fai-crm-ai-reconcile.service

sudo systemctl daemon-reload
sudo systemctl enable --now fai-crm-ai-reconcile.timer
```

Esecuzione manuale una tantum del service:

```bash
sudo systemctl start fai-crm-ai-reconcile.service
```

Controllo dello stato del timer e dell'ultima esecuzione:

```bash
systemctl status fai-crm-ai-reconcile.timer
systemctl status fai-crm-ai-reconcile.service
journalctl -u fai-crm-ai-reconcile.service -n 100 --no-pager
```

Disattivazione sicura:

```bash
sudo systemctl disable --now fai-crm-ai-reconcile.timer
sudo systemctl reset-failed fai-crm-ai-reconcile.service
```

Il service esegue nel container app esistente:

```bash
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml exec -T app npm run --silent ai:reconcile
```

Non copiare segreti nei file unit: le variabili restano in `/opt/fai-crm/.env.production`, già usato da Docker Compose.

## AI Orchestrator: State Machine Foundation v1.1

La fondazione dell'Orchestrator è additiva e nasce fail-closed con due controlli distinti: `stateMachineEnabled=false` e `dispatchEnabled=false`; restano obbligatori soli dati sintetici e provider `mock`. La definizione canonica conserva 16 stati e 23 transizioni, ma la porta applicativa della Foundation consente soltanto WF-001..WF-017 e nega WF-018..WF-023 con `FOUNDATION_SCOPE_LIMIT`. Nessun servizio di questa release può portare un'istanza oltre `HUMAN_APPROVAL`.

La State Machine Foundation non aggiungeva coda, worker, outbox, route pubbliche, UI, esecuzioni di agenti o chiamate provider e non modificava il reconciler AI già operativo. Le milestone richieste sono verificate sul ledger della fase o del ciclo corrente; ogni transizione accettata conserva uno snapshot minimizzato dei guard. Un vincolo PostgreSQL valida lo schema dello snapshot, lo lega alla transizione e ricalcola il relativo SHA-256 sul JSON canonico realmente persistito. OpenAI e tutti i provider esterni devono restare disabilitati secondo l'[AI Control Plane](ai-control-plane.md).

La Persistent Job Queue Foundation v1 è stata successivamente distribuita e aggiunge lo schema di una coda passiva e un outbox transazionale. I job possono essere esclusivamente `PLANNED` o `BLOCKED`; l'outbox originario è esclusivamente `PENDING`. Contratto e controlli sono descritti in [Persistent Job Queue Foundation v1](ai-orchestrator-persistent-job-queue-foundation.md) e nell'[ADR-0002](adr/0002-ai-orchestrator-persistent-job-queue-foundation.md).

La Worker Runtime Foundation v1, presente in `main` dalla PR76, aggiunge soltanto runtime, attempt, receipt outbox, audit e primitive interne. Non installa un processo worker, script, timer o unità systemd; non crea `AiRun`, non applica transizioni e non invoca provider. Introduce il gate ambiente `AI_ORCHESTRATOR_WORKER_ENABLED`, che deve restare `0` in produzione, e tredici kill switch database separati per capability, tutti creati con `enabled=false`. Anche `stateMachineEnabled` e `dispatchEnabled` devono restare `false`; la migration non ne modifica i valori. Dettagli e rollback sono descritti in [Worker Runtime Foundation v1](ai-orchestrator-worker-runtime-foundation.md) e nell'[ADR-0003](adr/0003-ai-orchestrator-worker-runtime-foundation.md).

Il merge della fondazione non autorizza deploy. Prima di una distinta finestra production approvata eseguire un backup validato; dopo `prisma migrate deploy` verificare health, permessi v2, flussi CRM esistenti e, in sola lettura, i valori sicuri del setting globale. La presenza delle nuove tabelle non autorizza l'attivazione della state machine, del dispatch o test con dati cliente reali.

In caso di rollback mantenere o riportare `stateMachineEnabled=false`, mantenere `dispatchEnabled=false` e i provider esterni disabilitati, quindi ripristinare l'immagine applicativa precedente lasciando intatte le nuove tabelle: non eliminare volumi, snapshot, ledger, job, outbox o dati audit. Finché una migration non è unita né distribuita, non è richiesta alcuna operazione sul database. Contratto, test, procedura completa e rollback della prima fondazione sono descritti in [AI Orchestrator: State Machine Foundation v1.1](ai-orchestrator-state-machine-foundation.md); la correzione della specifica resta proposta nell'[ADR-0001](adr/0001-ai-audit-workflow-v1-1.md).

## AI Orchestrator Result & Artifact Contract Foundation v1

La fondazione result/artifact v1 è dormiente e non abilita worker, dispatch, provider esterni o accesso a dati CRM reali. Prima di qualunque deploy futuro devono restare chiusi `stateMachineEnabled=false`, `dispatchEnabled=false`, `syntheticDataOnly=true`, `provider=mock`, `externalProvidersEnabled=false`, `AI_ORCHESTRATOR_WORKER_ENABLED=0` o mancante e tutte le 13 capability worker `enabled=false`.

Rollback applicativo: mantenere i gate chiusi, ripristinare l'immagine PR76 e lasciare intatte le tabelle `AiWorkflowJobResult`, `AiWorkflowJobArtifact` e `AiWorkflowJobSourceArtifact`. Non eseguire DROP/TRUNCATE/reset/down migration; un restore database è una procedura separata.

## AI Orchestrator Mock Handler Registry Foundation v1

La fondazione registry v1, presente in `main` dalla PR78, definisce esclusivamente in TypeScript i 13 handler `mock`/`synthetic`, le loro identità hashate, l'invocation strict e le fixture deterministiche validate dal contratto result/artifact. Non introduce né avvia worker, runtime loop, scheduler, route o dispatch; non accede a rete, provider, database o dati CRM reali e non aggiunge schema Prisma, migration, seed o backfill.

Il limite temporale del registry è un budget osservato post-esecuzione, non un hard timeout: il vero isolamento preemptive appartiene a una futura PR del processo worker. Il merge della PR #78 non autorizza deploy o attivazione. Tutti i gate e le 13 capability devono restare chiusi; un eventuale rollback è soltanto applicativo e non richiede alcuna operazione sul database.

## AI Orchestrator Admin Control Plane Foundation v1

La fondazione PR79 è esclusivamente ledger-only: registra revisioni `desired`, identità di comando, vincoli CAS/idempotency e audit amministrativo; l'`effective` è derivato ma non viene scritto nei setting runtime. Nessuna policy è collegata a worker, runtime, handler o dispatch. Il derivatore `FOUNDATION_LOCKED_V1` mantiene ogni effetto operativo fail-closed e le 36 revisioni genesis devono risultare tutte `OFF`/`KILLED`.

Una policy `desired` staged non può diventare effettiva dopo un aggiornamento futuro senza una nuova activation epoch e una nuova revisione esplicitamente autorizzata. I nove permessi RBAC dedicati (`read`, `configure`, `enable`, `disable`, `kill`, `retry`, `audit`, `limits`, `agents`) sono assegnati per default soltanto ad `admin`; conferma e motivazione non sostituiscono i kill switch infrastrutturali o PostgreSQL e non consentono di aggirare `HUMAN_APPROVAL`, mutare identità canoniche o abilitare provider esterni.

La PR79 non aggiunge Control Center UI, route, server action, worker, scheduler, cron, timer, systemd, dispatch, rete, provider, dati CRM reali, `AiRun` o `AiOutput`. In produzione devono restare:

```text
AI_ORCHESTRATOR_WORKER_ENABLED=0
AI_EXTERNAL_PROVIDERS_ENABLED=false
AI_ALLOWED_MODELS=
stateMachineEnabled=false
dispatchEnabled=false
syntheticDataOnly=true
provider=mock
externalProvidersEnabled=false
13 capability enabled=false
36 policy effective=OFF/KILLED
```

L'emergency stop appende una revisione di riduzione del rischio e non cancella o riscrive job, lease, attempt, result o ledger. I limiti v1 sono hard upper bound, ma restano dichiarativi finché una futura activation epoch non viene collegata da una PR separata a un vero processo worker.

La PR #79 è stata unita e distribuita in modalità dormiente il 21 luglio 2026; il collaudo production si è concluso con `PR79_SMOKE_OK`. La distribuzione non ha autorizzato l'attivazione di worker, state machine, dispatch o provider esterni. Continuare a verificare in sola lettura il vincolo `AiOrchestratorSetting_dispatch_disabled_check`, le 36 teste canoniche, i tredici kill switch e l'assenza di backfill operativo. Il rollback ordinario ripristina l'immagine precedente mantenendo tutte le tabelle additive e lo storico append-only; non usare `DROP`, `TRUNCATE`, reset o down migration. Il contratto completo è descritto in [Admin Control Plane Foundation v1](ai-orchestrator-admin-control-plane-foundation-v1.md) e nell'[ADR-0006](adr/ADR-0006-ai-orchestrator-admin-control-plane-foundation-v1.md).

## AI Orchestrator Admin UI Foundation v1 — PR80

La pagina `/settings/ai-orchestrator` registra esclusivamente policy `desired` nel ledger PR79 e mostra uno stato `effective` sempre fail-closed sotto `FOUNDATION_LOCKED_V1`. Non è collegata a worker, coda, runtime, handler, dispatch o provider. Il deploy della UI non autorizza l'attivazione operativa.

La migration additiva proposta:

- esegue un preflight count-only sulle motivazioni immutabili;
- si arresta senza stampare o modificare contenuti incompatibili;
- aggiunge e valida `AiOAdminPolicy_reason_minimized_v1_check`;
- limita `reason` anche a 500 unità UTF-16 per preservare la leggibilità in rollback PR79;
- conserva il precedente `AiOAdminPolicy_reason_check`;
- aggiunge `AiOAdminPolicy_audit_cursor_idx(createdAt, id)`;
- allinea atomicamente la matrice permessi PostgreSQL a `STOPPED < PAUSED < DRAINING < READY`;
- non aggiorna revisioni, hash, setting o record operativi.

### Sequenza DB-first

Eseguire questa sequenza soltanto dopo merge e autorizzazione esplicita della finestra production:

1. identificare SHA e immagine approvati;
2. verificare health di CRM e PostgreSQL;
3. creare e validare un backup production;
4. verificare in sola lettura tutti i gate dormienti;
5. avviare PostgreSQL senza sostituire ancora l'immagine applicativa;
6. eseguire `prisma migrate deploy` con la migration committata;
7. fermarsi se il preflight rileva revisioni incompatibili;
8. verificare vincolo reason, indice audit, catalogo e barriera dispatch;
9. distribuire la nuova immagine;
10. verificare health, login e pagina Admin Orchestrator in sola lettura.

Comando migration, usando il flusso Compose production già documentato:

```bash
docker compose -p fai-crm --env-file .env.production -f docker-compose.prod.example.yml run --rm app npm run prisma:migrate:deploy
```

Se la migration fallisce, non avviare l'immagine PR80 e non tentare di sanificare `reason`: il campo partecipa agli hash append-only. Conservare l'errore count-only, lasciare l'immagine PR79 e aprire una decisione tecnica separata.

### Verifiche database post-migration

Eseguire con un client PostgreSQL autorizzato e in modalità di sola lettura:

```sql
SELECT conname, convalidated
FROM pg_constraint
WHERE conrelid = '"AiOrchestratorAdminPolicyRevision"'::REGCLASS
  AND conname IN (
    'AiOAdminPolicy_reason_check',
    'AiOAdminPolicy_reason_minimized_v1_check'
  )
ORDER BY conname;

SELECT indexname
FROM pg_indexes
WHERE schemaname = CURRENT_SCHEMA()
  AND tablename = 'AiOrchestratorAdminPolicyRevision'
  AND indexname = 'AiOAdminPolicy_audit_cursor_idx';

SELECT COUNT(*) AS "canonicalHeads"
FROM (
  SELECT DISTINCT ON ("scopeType", "scopeCode") "scopeType", "scopeCode"
  FROM "AiOrchestratorAdminPolicyRevision"
  ORDER BY "scopeType", "scopeCode", "version" DESC
) heads;

SELECT "stateMachineEnabled", "dispatchEnabled", "syntheticDataOnly", "provider"
FROM "AiOrchestratorSetting"
WHERE "id" = 'global';

SELECT COUNT(*) AS "enabledCapabilities"
FROM "AiOrchestratorWorkerCapabilitySetting"
WHERE "enabled" = true;
```

Risultati attesi immediatamente dopo la migration:

- entrambi i vincoli reason presenti e validati;
- indice audit presente;
- 36 teste canoniche;
- `stateMachineEnabled=false`;
- `dispatchEnabled=false`;
- `syntheticDataOnly=true`;
- `provider=mock`;
- zero capability abilitate.

Verificare separatamente che `AiOrchestratorSetting_dispatch_disabled_check` resti presente, esatto e validato e che `externalProvidersEnabled=false`, `AI_ORCHESTRATOR_WORKER_ENABLED=0`, `AI_EXTERNAL_PROVIDERS_ENABLED=false` e `AI_ALLOWED_MODELS` sia vuota.

### Smoke autenticato

Dopo l'avvio della nuova immagine:

- verificare `/api/health`;
- accedere con un utente production autorizzato;
- aprire `/settings/ai-orchestrator`;
- confermare il banner **Configurazione desiderata, non operativa**;
- confermare stato effective non operativo, barriera fisica presente e zero capability abilitate;
- verificare che un utente privo di `ai.orchestrator.read` non veda né apra la pagina;
- verificare che la motivazione completa sia visibile soltanto con `ai.orchestrator.audit`;
- verificare i filtri audit “Tutto il ledger”, “Policy globale ed emergenze” e scope selezionato;
- non inviare form, non creare revisioni di prova e non usare dati cliente reali.

### Rollback PR80

Il rollback ordinario è applicativo:

1. mantenere chiusi worker, state machine, dispatch e provider esterni;
2. ripristinare l'immagine PR79 approvata;
3. riavviare lo stack senza eliminare volumi;
4. verificare health, login e gate dormienti;
5. lasciare nel database il nuovo vincolo reason, l'indice audit e tutte le revisioni append-only eventualmente create.

Il doppio limite Unicode/UTF-16 mantiene il ledger rileggibile dal codice PR79, che non dipende dall'indice. La funzione PostgreSQL conserva però la matrice RBAC più restrittiva della PR80: durante il rollback mantenere i gate chiusi e non effettuare mutazioni `PAUSED`/`DRAINING`. Non eseguire down migration, `DROP`, `TRUNCATE`, reset, `UPDATE` o `DELETE` del ledger. Un restore database è una procedura distinta, da usare solo con un piano specifico e backup validato, non come rollback ordinario della UI.

Contratto completo: [Admin UI Foundation v1](ai-orchestrator-admin-ui-foundation-v1.md) e [ADR-0007](adr/ADR-0007-ai-orchestrator-admin-ui-foundation-v1.md).

## AI Orchestrator Dormant Worker Process Foundation v1 — PR81

La PR81 include nell'immagine un entrypoint TypeScript manuale che definisce soltanto il lifecycle `DORMANT -> DRAINING -> STOPPED`, un polling interno senza datasource e un heartbeat JSONL minimizzato. Nel contratto PR81 isolato, `FOUNDATION_LOCKED_V1` mantiene `operational=false` e rifiuta sia `AI_ORCHESTRATOR_WORKER_ENABLED=1` sia valori ambigui. PR82 conserva questo percorso quando il gate è assente o `0` e introduce un routing lazy separato per il valore esatto `1`; ciò non autorizza il valore `1` in produzione.

Il processo non importa Prisma o la Worker Runtime Foundation, non legge `DATABASE_URL`, non accede a job, queue, outbox, lease, result, artifact, handler, provider o dati CRM e non applica transizioni. Il polling termina sempre con `NO_WORK_FOUNDATION_LOCKED`.

L'entrypoint è impacchettato ma **non installato**:

- `npm start` resta `next start`;
- il `CMD` Docker resta invariato;
- Docker Compose continua ad avere soltanto `app` e `postgres`;
- non vengono aggiunti systemd, timer, cron o scheduler;
- il reconciler AI esistente non viene modificato;
- Prisma resta a 29 migration.

In produzione mantenere esattamente:

```text
AI_ORCHESTRATOR_WORKER_ENABLED=0
AI_PROVIDER=mock
AI_EXTERNAL_PROVIDERS_ENABLED=false
AI_ALLOWED_MODELS=
stateMachineEnabled=false
dispatchEnabled=false
syntheticDataOnly=true
externalProvidersEnabled=false
13 capability enabled=false
```

Non invocare `npm run ai:orchestrator:worker` sul VPS. L'entrypoint è destinato al collaudo isolato della fondazione e a successive PR autorizzate. Anche dopo PR82 il gate production deve restare `0`.

Un eventuale deploy separatamente approvato deve verificare che non compaia alcun nuovo container o processo, che applicazione e PostgreSQL restino healthy e che tutti i gate siano invariati. Non sono richiesti `prisma migrate deploy` specifici per PR81 perché non esiste una migration nuova.

Rollback: ripristinare l'immagine PR80 mantenendo tutti i gate chiusi. Lasciare database, 29 migration, ledger, job, outbox, runtime e artifact intatti. Non usare down migration, `DROP`, `TRUNCATE`, reset, `UPDATE` o `DELETE` come rollback ordinario.

Contratto completo: [Dormant Worker Process Foundation v1](ai-orchestrator-dormant-worker-process-foundation-v1.md) e [ADR-0008](adr/ADR-0008-ai-orchestrator-dormant-worker-process-foundation-v1.md).

## AI Orchestrator Admission, Claim & Lease Wiring Foundation v1 — Draft PR82

La Draft PR82 collega in modo fail-closed il processo PR81 alle primitive PR76
tramite:

- un coordinatore single-flight per recovery, supersession, authority,
  admission, claim, heartbeat, surrender e drain;
- una facade che non espone `complete`, `fail`, payload, handler, result o
  artifact e conserva il token lease in un handle opaco;
- una lettura Control Plane machine-safe, transazionale e `READ ONLY`, che
  valida ledger, setting, capability e barriera dispatch senza simulare un
  attore amministrativo.

La composizione production PR82 fissa `canAcceptLease=false` e non possiede un
consumer. `FOUNDATION_LOCKED_V1` continua a restituire
`operational=false`, `databaseEligible=false`, `canAdmit=false`,
`canClaim=false` e `canHeartbeat=false`. I percorsi positivi admission/claim
sono esercitati soltanto con adapter sintetici nei test.

PR82 non invoca handler, non legge dati CRM reali, non persiste result,
artifact, `AiRun` o `AiOutput`, non applica transizioni e non usa rete o
provider. Non aggiunge servizi Compose, systemd, cron o scheduler; `npm start`
e il `CMD` Docker restano dedicati a Next.js. Schema e migration non cambiano:
il totale resta **29**.

In produzione mantenere:

```text
AI_ORCHESTRATOR_WORKER_ENABLED=0
AI_PROVIDER=mock
AI_EXTERNAL_PROVIDERS_ENABLED=false
AI_ALLOWED_MODELS=
stateMachineEnabled=false
dispatchEnabled=false
syntheticDataOnly=true
externalProvidersEnabled=false
13 capability enabled=false
```

La CI PR82 verifica lint, Prisma validate/generate, unit e PostgreSQL test,
typecheck, build, assenza di delta schema/migration e smoke Docker isolato. Lo
smoke avvia `app` e `postgres` dopo migration/seed, valida `/api/health`,
richiede HTTP 404 da `/_next/image`, prova il gate `0` con rete disabilitata e
confronta uno snapshot PostgreSQL prima/dopo il gate `1` sotto
`FOUNDATION_LOCKED_V1`.

La Draft PR **non autorizza merge, deploy o avvio sul VPS**. Un eventuale
rollout richiede approvazione distinta e deve lasciare gate `0`, due soli
servizi Compose e nessun processo worker.

Rollback ordinario: ripristinare l'immagine PR81
`fai-crm:pr81-39ed9040ba83`, senza down migration e senza modificare database,
ledger, job, outbox, runtime o artifact. Verificare health, login, flussi CRM e
processo dormiente PR81.

Le eccezioni transitive temporanee `sharp`/`postcss`, con owner FAI Engineering
e riesame entro il 31 agosto 2026, sono registrate nel
[contratto PR82](ai-orchestrator-admission-claim-lease-wiring-v1.md). Non usare
`npm audit fix --force`.

Contratto completo:
[Admission, Claim & Lease Wiring Foundation v1](ai-orchestrator-admission-claim-lease-wiring-v1.md)
e [ADR-0009](adr/ADR-0009-ai-orchestrator-admission-claim-lease-wiring-v1.md).
