# N07 — Core CRM Query, Index & Pagination Hardening v1

## Stato e confine

N07 rende bounded le letture dei registri core Lead e Clienti e corregge il confine di lettura condiviso per Task, AiRun e AiOutput. Non attiva exporter N06, AI, provider, integrazioni, portale, pagamenti o traffico esterno.

- pagina canonica: 50 record;
- over-fetch: 1 record, usato esclusivamente per determinare `hasNext`;
- pagina massima accettata: 200; input non canonico torna in modo deterministico a pagina 1;
- lookup di riferimento: massimo 250 record;
- helper ABAC con filtro applicativo: massimo 100 risultati e 500 candidati letti dal database;
- migration: 36, solo indici additivi; nessun backfill e nessuna modifica ai dati;
- feature gate e runtime N01–N06: invariati e dormienti.

## Correzione di sicurezza e correttezza

Prima di N07, gli helper `listAccessibleTasks` e `listAccessibleAiOutputs` separavano `take` dalla query Prisma e lo applicavano solo dopo il filtro ABAC. Questo consentiva una lettura non bounded e, quando `take` era omesso, `slice(0, undefined)` restituiva una lista vuota. N07 normalizza sempre il limite, applica un candidate budget al database e conserva il filtro ABAC fail-closed.

Il candidate budget non amplia mai l’accesso. Se la finestra contiene molti record non accessibili, il risultato può essere più corto del limite richiesto; i record non vengono mai resi visibili per riempire una pagina.

## Query Lead e Clienti

Le due liste usano ora:

1. autorizzazione tradotta in un `where` Prisma equivalente alle decisioni esistenti di `canViewLead` e `canViewClient`;
2. ordinamento totale con `id` come tie-breaker;
3. `skip` bounded e `take = 51`;
4. lookup correlati limitati ai soli ID della pagina;
5. link precedente/successiva che preservano i filtri e canonicalizzano `page`.

La lista Clienti non aggrega più servizi e documenti dell’intero database. I conteggi vengono richiesti solo per i Clienti della pagina; lo stato pratica usa un record distinto per cliente.

## Indici PostgreSQL

Migration 36 crea 11 indici nominati e coerenti con le query qualificate:

- pipeline Lead globale e per assegnatario;
- cursori Clienti globale, commerciale e consulente;
- stato servizio e conteggio documenti per cliente;
- Task attivi per scadenza e assegnatario;
- ordinamento recente di AiRun e AiOutput.

La migration contiene solo `CREATE INDEX` racchiusi in `BEGIN`/`COMMIT`. Non contiene `ALTER TABLE`, DML, `DROP`, `TRUNCATE` o reinterpretazioni storiche.

## SLO e telemetria N06

N07 usa il confine N06 senza collegare un transport. Le query interattive restano candidati per l’SLO di latenza delle operazioni critiche, ma nessun evento, metrica, dashboard o exporter viene attivato in questo slot. Il limite a monte impedisce che una lista cresca linearmente fino a leggere l’intera tabella.

## Verifica

```bash
node --import tsx --test tests/core-query-index-pagination-hardening.test.ts
npx prisma validate
npx prisma generate
npx tsc --noEmit --incremental false
npm run lint
npm test
npm run build
git diff --check
```

La CI applica esattamente 36 migration a PostgreSQL effimero, verifica gli 11 indici N07, esegue i test DB, il build e lo smoke Docker. Nessuna verifica N07 usa dati reali.

## Esclusioni dichiarate

N07 non trasforma ogni query di dettaglio in cursor pagination e non anticipa il performance hardening generale N40. Le viste di dettaglio bounded per entità, i report specializzati e la revisione globale del piano query restano fuori dal confine di questo slot.

**N07_CORE_CRM_QUERY_INDEX_PAGINATION_HARDENING_READY**
