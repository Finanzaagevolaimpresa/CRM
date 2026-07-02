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
4. Eseguire `npm install`.
5. Eseguire `npm run prisma:generate`.
6. Eseguire `npm run prisma:migrate`.
7. Eseguire `npm run prisma:seed`.
8. Avviare con `APP_ENV=development npm run dev`, aprire `/login` e accedere con le credenziali demo development.

### Lockfile npm

In un ambiente con accesso al registry npm non bloccato da proxy/firewall, generare e committare il lockfile con:

```bash
npm install --package-lock-only
```

Dopo la generazione verificare che `package-lock.json` sia presente, quindi eseguire il primo avvio locale con la checklist sopra. Nell'ambiente Codex corrente il download di `@prisma/client` da `https://registry.npmjs.org/@prisma%2fclient` può restituire `403 Forbidden` per policy del proxy; in questo caso non forzare workaround e mantenere la CI con `npm install` finché `package-lock.json` non è disponibile nel repository.

## Login locale development

Il seed crea un utente amministratore interno per sviluppo e test manuali:

- Email: `admin@fai.local`
- Password: `ChangeMe123!`
- Ruolo: `admin`

Per usare il pulsante rapido **Accedi come admin demo**, avviare Next.js con `APP_ENV=development npm run dev`. In alternativa, compilare il form di `/login` con email e password sopra. Dopo il login viene creato il cookie firmato `fai_crm_session` (o il nome definito in `AUTH_COOKIE_NAME`) con scadenza e redirect a `/dashboard`. Il logout interno cancella il cookie e riporta a `/login`.


## Provider AI

Il provider AI predefinito resta `mock`, adatto allo sviluppo locale senza costi e senza chiamate esterne:

```env
AI_PROVIDER="mock"
AI_API_KEY=""
AI_MODEL="gpt-4.1-mini"
```

Per abilitare il provider reale OpenAI solo lato server impostare (integrazione via `fetch` server-side, senza SDK/dipendenza runtime obbligatoria):

```env
AI_PROVIDER="openai"
AI_API_KEY="sk-..."
AI_MODEL="gpt-4.1-mini"
```

`AI_PROVIDER` viene normalizzato lato server con trim e lowercase: sono ammessi solo `mock` e `openai`; qualsiasi altro valore ricade coerentemente su `mock` sia nella diagnostica sia nelle esecuzioni reali. `AI_MODEL` è opzionale; se omesso viene usato `gpt-4.1-mini` come default prudente per bozze operative interne. La chiave `AI_API_KEY` non deve mai essere esposta al browser né inserita in variabili `NEXT_PUBLIC_*`. Se `AI_PROVIDER=openai` ma la chiave manca, l'app restituisce un errore operativo chiaro e non salva output fittizi.

L'uso di OpenAI può generare costi in base a token/modello. La CI resta su `AI_PROVIDER=mock` e non installa pacchetti OpenAI esterni: il provider reale usa la API HTTPS solo quando configurato lato server. Ogni output AI, sia mock sia OpenAI, nasce come bozza interna `needs_review` o `flagged`, mantiene la revisione umana obbligatoria e non deve promettere contributi, finanziamenti o approvazioni. In questo step non sono previsti streaming, upload file a OpenAI, né invio di `storagePath` o `checksum`.

## Smoke test interno

Dopo seed e avvio locale, verificare manualmente il flusso MVP interno:

1. Login con l’utente seed `admin@fai.local` / `ChangeMe123!`.
2. Apertura dashboard.
3. Creazione lead.
4. Creazione cliente.
5. Creazione progetto.
6. Registrazione documento.
7. Run AI mock.
8. Approvazione AI da parte di un utente interno.
9. Creazione dossier.
10. Contratto.
11. Pagamento.

## Architettura
- `prisma/schema.prisma`: schema dati per auth, CRM, documenti, AI, audit e soft delete.
- `src/lib/auth.ts`: sessione server, ruoli e permessi base.
- `src/lib/ai.ts`: adapter AI astratto con mock provider.
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

Eseguire questi comandi in un ambiente con accesso al registry npm non bloccato da proxy/firewall:

```bash
npm install --package-lock-only
npm install
npm run prisma:generate
npm run build
npm run dev
```

`package-lock.json` deve essere generato e committato da un ambiente non bloccato a livello network/proxy. Nell'ambiente Codex corrente il download dei pacchetti npm può restituire `403 Forbidden` per policy del proxy, non per configurazione del progetto.

## CI GitHub Actions

Il workflow `.github/workflows/ci.yml` esegue su push e pull request:

1. checkout del repository;
2. setup Node.js 22;
3. avvio servizio PostgreSQL 16;
4. `npm install`;
5. `npm run prisma:generate`;
6. `npm run prisma:migrate:deploy`;
7. `npm run build`.

La CI passerà a `npm ci` e riattiverà la cache npm in `actions/setup-node` solo dopo il commit di `package-lock.json`.
