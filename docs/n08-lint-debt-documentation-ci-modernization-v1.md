# N08 — Lint Debt, Documentation & CI Modernization v1

## Obiettivo

N08 chiude il debito tecnico residuo dell’Onda A senza introdurre capacità
funzionali, dipendenze, migration o attivazioni runtime. La baseline PR100
tollerava 28 warning ESLint e disabilitava globalmente `prefer-const` e
`react-hooks/purity`; la CI accettava fino a 30 warning.

## Contratto di qualità

- Node.js 22 è dichiarato una sola volta in `.nvmrc` e riutilizzato dalla CI.
- `npm ci` continua a usare esclusivamente `package-lock.json`.
- `npm run lint` applica ESLint a tutto il repository con zero warning ammessi.
- `prefer-const` e `react-hooks/purity` tornano ai valori prescritti dalla
  configurazione Next.js, senza override globali.
- `npm run typecheck` è il comando canonico per TypeScript e viene richiamato
  direttamente dal workflow GitHub Actions.
- `npm run verify:quality` aggrega lint, unit test e typecheck per la verifica
  locale riproducibile.
- La CI resta fail-closed e conserva audit dipendenze, Prisma, 36 migration,
  test PostgreSQL sintetici, build, smoke Docker, staging preflight e restore
  drill N-1.

## Bonifica eseguita

La pulizia elimina import, query e variabili inutilizzati; tipizza i mock
handler senza parametri fittizi; usa `next/image` per il logo; rende puro il
calcolo della finestra temporale del pannello tecnico; rende immutabili le
variabili di test assegnate una sola volta. Le modifiche non cambiano permessi,
workflow, output di business, provider o stato dei feature gate.

Questo documento registra la baseline effettiva di N08: Node.js 22, 36
migration e capacità AI dormienti, senza trasformare riferimenti storici in
stato operativo corrente.

## Vincoli preservati

- nessuna modifica a `prisma/schema.prisma` o `prisma/migrations`;
- nessuna modifica a `package-lock.json` o alle dipendenze;
- nessun provider esterno, worker, dispatch o egress abilitato;
- nessun dato reale usato nei test;
- nessun deploy o cambio di configurazione produttiva implicito.

## Verifica

```bash
npm ci
npm run lint
npx prisma validate
npm run prisma:generate
npm test
npm run typecheck
npm run build
```

La CI completa aggiunge le prove PostgreSQL, il packaging Docker e i drill N05.
Il rollback consiste nel revert integrale della PR N08: non esistono migration,
backfill o trasformazioni dati da compensare.
