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

Smoke test Docker sulla VPS (utile quando Docker non è disponibile in CI/Codex):

```bash
COMPOSE_PROJECT_NAME=fai-crm ./scripts/smoke-docker-prod.sh
```

Lo smoke test valida la configurazione Compose, costruisce l'immagine app e verifica nel runner che i comandi production siano risolvibili e che la directory documenti sia scrivibile.

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
