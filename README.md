# FAI CRM interno

MVP proprietario per Finanza Agevola Impresa S.r.l. basato su Next.js App Router, TypeScript, Prisma, PostgreSQL e Tailwind CSS.

## Principi compliance
- La società non eroga finanziamenti, non promette risultati, non garantisce contributi e non opera come intermediario finanziario.
- Ogni output AI è una bozza interna, nasce `needs_review`, richiede revisione umana e non viene inviato automaticamente al cliente.
- I documenti sono metadati nel database e file in storage privato esterno; l'accesso avviene tramite URL firmati.
- La prima versione non include area cliente pubblica, email/WhatsApp automatici, firma digitale, pagamenti online, scraping bandi o collegamenti bancari automatici.

## Installazione locale
1. Copiare `.env.example` in `.env` e configurare `DATABASE_URL`.
2. Avviare PostgreSQL locale.
3. Eseguire `npm install`.
4. Eseguire `npm run prisma:generate`.
5. Eseguire `npm run prisma:migrate`.
6. Eseguire `npm run prisma:seed`.
7. Avviare con `npm run dev` e aprire `/dashboard`.

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
6. `npm run build`.
