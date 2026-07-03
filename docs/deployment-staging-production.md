# Deploy staging/produzione CRM FAI

Questa guida prepara il CRM FAI per ambienti raggiungibili via HTTPS, ad esempio `https://crm.finanzaagevolaimpresa.it`, mantenendo invariato il comportamento locale esistente.

## Ambienti

### Locale

- Uso: sviluppo e test manuali interni su macchina dello sviluppatore.
- Avvio tipico: `APP_ENV=development npm run dev`.
- Database: PostgreSQL Docker locale configurato in `DATABASE_URL`.
- Storage documenti: filesystem locale privato.
- AI: provider `mock` predefinito oppure OpenAI opzionale solo server-side.
- Credenziali demo: ammesse solo per development.

### Staging

- Uso: verifica pre-produzione dell'integrazione WordPress → CRM e dei flussi interni.
- URL: dominio o sottodominio HTTPS non pubblico/promosso, protetto e accessibile solo a utenti interni/autorizzati.
- Database: istanza PostgreSQL separata da locale e produzione.
- Storage documenti: root separata da locale e produzione, non servita dal web server.
- Secret: reali, lunghi e diversi da locale/produzione.
- Credenziali demo: da non usare; creare utenti interni nominativi.

### Produzione

- Uso: CRM operativo interno raggiungibile dal sito WordPress tramite endpoint HTTPS.
- URL previsto: `https://crm.finanzaagevolaimpresa.it`.
- Accesso: solo utenti interni; non creare area cliente pubblica.
- Database e storage: servizi persistenti con backup e monitoraggio.
- Secret: reali, lunghi, ruotabili e conservati in secret manager o variabili ambiente sicure.
- Credenziali demo: disattivare o cambiare l'admin demo prima del go-live.

## Variabili ambiente obbligatorie

Configurare le variabili lato server, senza prefisso `NEXT_PUBLIC_` per secret e chiavi private.

| Variabile | Obbligatoria | Note |
| --- | --- | --- |
| `DATABASE_URL` | Sì | Stringa di connessione PostgreSQL dell'ambiente. Non loggare e non esporre. |
| `APP_ENV` | Sì | Valori consigliati: `development`, `staging`, `production`. |
| `AUTH_COOKIE_NAME` | Sì | Nome cookie sessione, ad esempio `fai_crm_session`. |
| `AUTH_SECRET` | Sì | Deve essere una stringa lunga, casuale e reale; diversa per ogni ambiente. |
| `STORAGE_PROVIDER` | Sì | Valore attualmente supportato: `local`. Non configurare `s3`/cloud storage finché non viene implementato nel codice runtime. |
| `LOCAL_DOCUMENT_STORAGE_ROOT` | Sì | Directory privata e persistente del server per i documenti quando `STORAGE_PROVIDER="local"`. Non deve essere dentro una directory pubblica servita dal web server. |
| `AI_PROVIDER` | Sì | `mock` per ambienti senza AI reale oppure `openai` quando configurato server-side. |
| `AI_API_KEY` | Sì se `AI_PROVIDER=openai` | Chiave API mantenuta solo server-side; mai nel browser, mai in `NEXT_PUBLIC_*`, mai nei log. |
| `AI_MODEL` | Sì | Modello usato dal provider AI configurato. |
| `WEBSITE_LEAD_WEBHOOK_SECRET` | Sì | Deve essere una stringa lunga, casuale e reale condivisa solo tra WordPress e CRM. |

Generare `AUTH_SECRET` e `WEBSITE_LEAD_WEBHOOK_SECRET` con un generatore crittograficamente sicuro. Non riutilizzare valori demo, brevi o prevedibili.

### Storage documenti supportato in questa versione

In staging e produzione configurare esplicitamente:

```env
STORAGE_PROVIDER="local"
LOCAL_DOCUMENT_STORAGE_ROOT="/percorso/privato/persistente/fai-crm/documents"
```

`LOCAL_DOCUMENT_STORAGE_ROOT` deve puntare a una directory privata e persistente del server, fuori da qualunque root pubblica servita da Nginx, Apache, CDN o static hosting. S3/cloud storage è un TODO futuro: non impostare `STORAGE_PROVIDER="s3"` in staging o produzione finché il provider non viene implementato e abilitato nel codice runtime.

## Sicurezza produzione

- HTTPS obbligatorio per tutto il traffico verso il CRM, incluso `POST /api/integrations/website/leads` dal sito WordPress.
- Usare cookie sicuri in produzione se supportato dalla configurazione applicativa esistente; verificare che sessioni e reverse proxy preservino lo schema HTTPS.
- Non esporre directory private come `storage/private/documents` via Nginx, Apache, CDN o static hosting.
- Configurare backup automatici del database PostgreSQL e test periodici di restore.
- Configurare backup dello storage documenti e test periodici di restore.
- Non loggare `DATABASE_URL`, `AUTH_SECRET`, `WEBSITE_LEAD_WEBHOOK_SECRET`, `AI_API_KEY` o header di autenticazione.
- Non usare credenziali demo in produzione.
- Disattivare, eliminare o cambiare password dell'admin demo prima del go-live.
- Mantenere accesso solo per utenti interni FAI autorizzati.
- Non creare pagine o area cliente pubblica nel CRM.

## Integrazione WordPress → CRM

WordPress deve inviare i lead all'URL HTTPS pubblico del CRM:

```text
POST https://crm.finanzaagevolaimpresa.it/api/integrations/website/leads
Header: x-fai-webhook-secret: <WEBSITE_LEAD_WEBHOOK_SECRET>
Content-Type: application/json
```

Il secret del webhook deve coincidere con quello configurato nel CRM e deve rimanere server-side anche lato WordPress. L'endpoint non sostituisce il login interno e non rende pubbliche le pagine CRM.

## Health check

Il CRM espone:

```text
GET /api/health
```

La risposta è minimale e non contiene dettagli sensibili:

```json
{ "ok": true, "app": "fai-crm", "env": "production", "timestamp": "2026-07-03T10:30:00.000Z" }
```

Usare l'endpoint per load balancer o uptime monitoring. Non aggiungere alla risposta `DATABASE_URL`, secret, API key, stack trace o dettagli interni del database.

## Procedura consigliata pre go-live

1. Creare database e storage dedicati all'ambiente.
2. Configurare tutte le variabili ambiente obbligatorie.
3. Eseguire `npm ci` su artifact/host con lockfile disponibile.
4. Eseguire `npm run prisma:generate`.
5. Applicare migration esistenti con `npm run prisma:migrate:deploy` quando previste dal flusso di rilascio.
6. Eseguire `npm run build`.
7. Verificare `GET /api/health` via HTTPS.
8. Verificare login interno con utenti reali non demo.
9. Verificare invio lead da WordPress verso `/api/integrations/website/leads` con secret corretto.
10. Verificare backup database e storage documenti.

## Note operative

- Questo step non introduce Docker production obbligatorio.
- Se in futuro serve un container production, documentare Dockerfile, reverse proxy, volumi persistenti, health check e strategia backup in una modifica dedicata.
- Non modificare il setup locale per mantenere compatibilità con lo sviluppo corrente.
