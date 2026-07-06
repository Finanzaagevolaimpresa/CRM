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
- `AI_PROVIDER`: lasciare `mock` se non si vuole usare un provider reale.
- `AI_API_KEY`: solo server-side e solo se richiesta dal provider AI configurato. Non creare variabili `NEXT_PUBLIC_*` per questa chiave.
- `WEBSITE_LEAD_WEBHOOK_SECRET`: segreto lungo per l'endpoint lead WordPress, se usato.

Le variabili S3 in `.env.production.example` sono placeholder coerenti con la configurazione prevista, ma il runtime attuale documenta `local` come provider operativo. Non impostare `STORAGE_PROVIDER=s3` finché l'implementazione S3 non è completata e collaudata.

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
