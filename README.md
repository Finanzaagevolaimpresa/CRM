# FAI CRM interno

MVP proprietario per Finanza Agevola Impresa S.r.l. basato su Next.js App Router, TypeScript, Prisma, PostgreSQL e Tailwind CSS.

## Principi compliance
- La società non eroga finanziamenti, non promette risultati, non garantisce contributi e non opera come intermediario finanziario.
- Ogni output AI è una bozza interna, nasce `needs_review`, richiede revisione umana e non viene inviato automaticamente al cliente.
- I documenti sono metadati nel database e file in storage privato esterno; l'accesso avviene tramite URL firmati.
- La prima versione non include area cliente pubblica, email/WhatsApp automatici, firma digitale, pagamenti online, scraping bandi o collegamenti bancari automatici.

## Installazione locale

### Checklist primo avvio locale
1. Copiare `.env.example` in `.env`.
2. Valorizzare `DATABASE_URL` con la connessione PostgreSQL locale.
3. Valorizzare `AUTH_SECRET` con un segreto lungo e non condiviso.
4. Eseguire `npm ci`.
5. Eseguire `npm run prisma:generate`.
6. Eseguire `npm run prisma:migrate`.
7. Eseguire `npm run prisma:seed`.
8. Avviare con `APP_ENV=development npm run dev`, aprire `/login` e accedere con le credenziali demo development.

### Lockfile npm

`package-lock.json` è versionato. Usare `npm ci` in CI, nei build Docker e per
installazioni riproducibili; non rigenerare il lockfile e non eseguire
`npm audit fix --force` come parte di un deploy.

## Login locale development

Il seed crea un utente amministratore interno per sviluppo e test manuali:

- Email: `admin@fai.local`
- Password: `ChangeMe123!`
- Ruolo: `admin`

Per usare il pulsante rapido **Accedi come admin demo**, avviare Next.js con `APP_ENV=development npm run dev`. In alternativa, compilare il form di `/login` con email e password sopra. Dopo il login viene creato il cookie firmato `fai_crm_session` (o il nome definito in `AUTH_COOKIE_NAME`) con scadenza e redirect a `/dashboard`. Il logout interno cancella il cookie e riporta a `/login`.


## AI Control Plane

Il provider predefinito resta `mock`, senza chiamate esterne. Il Control Plane v1 applica un doppio kill switch: per usare OpenAI devono essere attivi sia il gate ambiente sia lo switch globale nel database. La configurazione iniziale è fail-closed:

```env
AI_PROVIDER="mock"
AI_API_KEY=""
AI_MODEL=""
AI_EXTERNAL_PROVIDERS_ENABLED="false"
AI_ALLOWED_MODELS=""
```

La allowlist vuota non autorizza alcun modello esterno. Per una chiamata OpenAI servono inoltre agente configurato con modello ammesso, `ai.run`, `ai.external.run`, conferma esplicita dell'operatore, limite orario disponibile e chiave API server-side. La chiave non viene mai mostrata dall'interfaccia e non deve usare il prefisso `NEXT_PUBLIC_*`.

Le richieste alla Responses API impostano `store: false`; ciò non equivale a Zero Data Retention. I dati API non sono usati per il training per impostazione predefinita, mentre i log di abuse monitoring possono essere conservati fino a 30 giorni. ZDR o Modified Abuse Monitoring richiedono verifiche e configurazioni OpenAI separate. Staging e produzione devono avere progetti, chiavi, budget, allowlist e switch distinti.

Ogni output resta una bozza interna con revisione e approvazione umana; non viene effettuato alcun invio automatico. Configurazione, procedura di attivazione, minimizzazione del payload e indicazioni privacy/retention sono descritte in [`docs/ai-control-plane.md`](docs/ai-control-plane.md).

## Smoke test interno

Dopo seed e avvio locale, verificare manualmente il flusso MVP interno:

1. Login con l’utente seed `admin@fai.local` / `ChangeMe123!`.
2. Apertura dashboard.
3. Creazione lead.
4. Creazione cliente.
5. Creazione progetto.
6. Registrazione documento.
7. Run agente AI (`mock` oppure provider esterno esplicitamente abilitato).
8. Approvazione AI da parte di un utente interno.
9. Creazione dossier.
10. Contratto.
11. Pagamento.

## Architettura
- `prisma/schema.prisma`: schema dati per auth, CRM, documenti, AI, audit e soft delete.
- `src/lib/auth.ts`: sessione server, ruoli e permessi base.
- `src/lib/ai.ts`: adapter AI per provider `mock` e OpenAI, con richieste esterne server-side.
- `src/lib/ai-control-plane.ts`: doppio gate, allowlist modelli, conferma e rate limit per provider esterni.
- `src/lib/compliance.ts`: disclaimer e intercettazione frasi vietate.
- `src/lib/storage.ts`: placeholder per signed URL su storage privato.
- `src/app/*`: pagine MVP richieste.

## Roadmap TODO
- Implementare server actions CRUD con validazione Zod per ogni modulo.
- Collegare sessioni reali e password login/logout con cookie sicuri.
- Integrare S3/Supabase Storage con upload/download privati e audit.
- Aggiungere test unitari, e2e e policy RBAC granulari.
- Generare migration SQL completa in ambienti con Prisma installato.
- Aggiungere viste kanban per lead, task e pratiche.

## Validazione locale

Eseguire questi comandi:

```bash
npm ci
npm run lint
npx prisma validate
npm run prisma:generate
npm test
npx tsc --noEmit --incremental false
npm run build
```

## CI GitHub Actions

Il workflow `.github/workflows/ci.yml` esegue su push e pull request:

1. checkout del repository;
2. setup Node.js 22;
3. avvio servizio PostgreSQL 16;
4. `npm ci`, validazione Prisma, generate e lint;
5. test unitari e PostgreSQL, migration e seed production idempotente;
6. typecheck e build;
7. controlli diff/shell e smoke Docker isolato con health applicativa.

Per la PR82 la CI verifica inoltre che le migration restino esattamente 29 e
che non cambino né `prisma/schema.prisma` né `prisma/migrations`.

## AI Orchestrator Worker Wiring PR82

La Draft PR82 collega il processo PR81 alle primitive admission, claim e lease
della PR76 tramite una facade ristretta e un'autorità Control Plane read-only.
La composizione production resta non operativa: `AI_ORCHESTRATOR_WORKER_ENABLED=0`,
`canAcceptLease=false`, provider `mock`, dati esclusivamente sintetici e nessun
handler, result, artifact, provider esterno o nuova migration. Contratto,
verifiche e rollback sono descritti in
[`docs/ai-orchestrator-admission-claim-lease-wiring-v1.md`](docs/ai-orchestrator-admission-claim-lease-wiring-v1.md).

## Staging/Produzione

Per preparare il CRM FAI a staging o produzione usare la guida dedicata [`docs/PRODUCTION.md`](docs/PRODUCTION.md). La guida copre prerequisiti server, variabili ambiente, build, Prisma generate, migration deploy solo per migration già esistenti, reverse proxy HTTPS, storage documenti, backup/restore, health check `GET /api/health` e checklist sicurezza produzione.

Resta disponibile anche la guida storica [`docs/deployment-staging-production.md`](docs/deployment-staging-production.md) per dettagli staging e integrazione WordPress → CRM. In questa versione lo storage documenti supportato è `STORAGE_PROVIDER="local"`: non usare `s3` in staging/produzione finché non viene implementato nel codice runtime.

Il CRM resta un'applicazione interna protetta: non è prevista un'area cliente pubblica e le credenziali demo non devono essere usate in produzione.

## Integrazione sito WordPress FAI → CRM lead intake

Il CRM espone un endpoint server-side interno per ricevere lead dal sito WordPress `finanzaagevolaimpresa.it` senza creare un'area cliente pubblica e senza esporre pagine CRM non autenticate.

- Endpoint: `POST /api/integrations/website/leads`
- Header obbligatorio: `x-fai-webhook-secret: <valore WEBSITE_LEAD_WEBHOOK_SECRET>`
- Variabile server obbligatoria: `WEBSITE_LEAD_WEBHOOK_SECRET`, da mantenere segreta e non inserire mai in variabili `NEXT_PUBLIC_*`.
- WordPress/WPForms deve inviare una richiesta `POST` JSON con l'header `x-fai-webhook-secret` valorizzato con lo stesso secret configurato lato CRM.
- Il CRM salva il lead nella pipeline commerciale con fonte `Sito web`, registra audit log interni e non invia email automatiche.

Esempio `curl`:

```bash
curl -X POST "https://crm.example.com/api/integrations/website/leads" \
  -H "content-type: application/json" \
  -H "x-fai-webhook-secret: $WEBSITE_LEAD_WEBHOOK_SECRET" \
  -d '{
    "firstName": "Mario",
    "lastName": "Rossi",
    "companyName": "Rossi SRL",
    "email": "mario.rossi@example.com",
    "phone": "+390300000000",
    "city": "Brescia",
    "region": "Lombardia",
    "interest": "Finanza agevolata",
    "requestedAmount": 50000,
    "message": "Vorrei valutare un bando per investimenti digitali.",
    "sourcePage": "https://www.finanzaagevolaimpresa.it/contatti/",
    "serviceInterest": "Pre-Analisi AI Ammissibilità FAI",
    "privacyAccepted": true,
    "marketingAccepted": false,
    "submittedAt": "2026-07-03T10:30:00.000Z"
  }'
```

Esempio PowerShell:

```powershell
$headers = @{
  "content-type" = "application/json"
  "x-fai-webhook-secret" = $env:WEBSITE_LEAD_WEBHOOK_SECRET
}
$body = @{
  firstName = "Mario"
  lastName = "Rossi"
  companyName = "Rossi SRL"
  email = "mario.rossi@example.com"
  phone = "+390300000000"
  city = "Brescia"
  region = "Lombardia"
  interest = "Finanza agevolata"
  requestedAmount = 50000
  message = "Vorrei valutare un bando per investimenti digitali."
  sourcePage = "https://www.finanzaagevolaimpresa.it/contatti/"
  serviceInterest = "Pre-Analisi AI Ammissibilità FAI"
  privacyAccepted = $true
  marketingAccepted = $false
  submittedAt = "2026-07-03T10:30:00.000Z"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://crm.example.com/api/integrations/website/leads" -Headers $headers -Body $body
```
