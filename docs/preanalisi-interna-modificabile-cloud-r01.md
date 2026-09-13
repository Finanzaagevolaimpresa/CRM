# Preanalisi interna modificabile — Cloud R01

## Perimetro consegnato

Il percorso manuale parte dal fascicolo cliente o dal progetto e vincola la coppia cliente/progetto. La creazione non avviene all'apertura della pagina. Sono modificabili esclusivamente `internalSummary`, `scenarioA`, `scenarioB`, `blockingConditions` e `requiredDocuments`.

La scrittura richiede `project.write` e il contesto di scrittura già in uso. Il dettaglio continua a richiedere la lettura pertinente. Parametri, campi hidden e versione sono trattati come input non fidati e riverificati dal server.

Sono modificabili solo record manuali negli stati `da_avviare` o `raccolta_dati`, senza run AI, revisore o approvazione. L'aggiornamento usa `updatedAt` come compare-and-swap; un conflitto conserva i valori nel form e produce un messaggio recuperabile. Creazione/aggiornamento e audit avvengono nella stessa transazione. L'audit registra autore, record e nomi dei campi interessati, non il contenuto narrativo.

## Limiti dichiarati

- Nessuna transizione, revisione, approvazione, archiviazione o cancellazione.
- Nessuna migrazione: lo schema e le 44 migrazioni restano invariati.
- Nessun provider, run AI, worker, invio, deploy o dato reale.
- `deploy_required=false`, `migration_required=false`, `production_change_required=false`.
- P4 resta sospesa, Q04 aperta, pilota bloccato e accesso a chiavi reali assente.

## Qualifica R02

La CI contiene un job dedicato con PostgreSQL 16 effimero identificato dal sentinel canonico e Chromium. I test DB esercitano persistenza, contesto incoerente, lettura/scrittura estranea, revoca del permesso, cambio assegnazione, cancellazione logica del progetto, stato/versione non validi, no-op valido, concorrenza e rollback su fault dell'audit.

Il percorso browser autentica esclusivamente identità inventate e attraversa progetto, creazione, compilazione dei cinque campi, salvataggio, ricarica e seconda modifica. Due schede producono un conflitto recuperabile conservando i testi. Verifica inoltre utente estraneo e utente con `dossier.read` negato, producendo receipt JSON e screenshot desktop/stretto come artifact.

La qualifica fisica Q04 non viene eseguita né modificata.
