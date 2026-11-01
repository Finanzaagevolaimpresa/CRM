# Avvio locale CRM riproducibile

Il comando ordinario del candidato è:

```powershell
npm run dev -- --hostname 127.0.0.1 --port 3052
```

Lo script `dev` di `package.json` esegue `next dev --webpack`. Il comando usa quindi lo stesso compilatore delle prove locali, senza richiedere un flag aggiunto a mano. `src/instrumentation.ts` importa registro sessioni e Prisma soltanto nel ramo esplicito `NEXT_RUNTIME === "nodejs"`; mantiene i controlli ordinari di attivazione del registro e del modo legacy.

Sul checkout MSI qualificato le dipendenze operative sono su C: e le sorgenti rimangono quelle del candidato. L'archivio su E: viene conservato. Non occorrono variabili globali, modifiche al provider o riparazioni Docker per avviare questo comando.

## Prova ripetibile con dati sintetici

La sequenza canonica è nel job browser di [Technical confidentiality](../.github/workflows/technical-confidentiality.yml):

1. Usare soltanto PostgreSQL locale isolato, database vuoto `fai_crm_test`, schema75 e sentinella `FAI_CRM_EPHEMERAL_TEST_ONLY_V1`. I valori di ambiente sintetici del job valgono per quel solo processo. Configurare `LOCAL_DOCUMENT_STORAGE_ROOT` e `TECHNICAL_EVIDENCE` in due directory dedicate.
2. Verificare lo schema con `node scripts/m4/verify-schema.mjs`, quindi eseguire `node --import tsx tests/technical-confidentiality/provision-browser.ts`. La fixture revoca soltanto le proprie sessioni sintetiche e verifica l'attivazione ordinaria del registro prima dell'avvio. Non usare un database reale o un registro non pronto.
3. Avviare il comando ordinario sopra. Verificare HTTP200 su `http://127.0.0.1:3052/api/health`.
4. Eseguire `npx playwright test --config tests/technical-confidentiality/playwright.config.ts --reporter=line,json`. Le sessioni nascono dal normale modulo Login interno; non viene iniettato un cookie.
5. Conservare rapporto JSON, log, prove e database della singola esecuzione. Per una nuova fixture usare un altro ambiente vuoto, senza cancellare la prova precedente o aggirare i controlli del registro.

La sola risposta di health attesta l'avvio del server. Il rapporto della suite distingue login, contenuti ammessi, dinieghi, file, collaborazione e revoca. I risultati sintetici non attestano le sessioni o i dati della produzione.
