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

## Correzione consolidata R03

Il job usa due URI distinti: `DATABASE_URL` conserva il parametro Prisma `schema=public`, mentre `psql` usa una URI PostgreSQL nativa. La password browser sintetica viene mascherata ed esportata nello step che esegue il provision. Una ricevuta minimizzata esiste prima di migrazioni e browser, così anche un arresto anticipato produce solo fase, esito e indicatore sintetico.

La qualifica transazionale dimostra entrambe le autorità previste da `canEditProject`: cambiare il solo consulente del progetto conserva l'accesso derivato dal cliente; soltanto la revoca di entrambe nega la scrittura senza mutazione o audit. Copre inoltre azienda del progetto cancellata o appartenente a un altro cliente, anche senza `companyId` nell'input, e sessione registry revocata con motivo canonico `INTERNAL_SINGLE`.

Il browser invia anche una creazione con campo hidden alterato e tenta un aggiornamento dopo la revoca di `dossier.read` successiva all'apertura del form. Entrambi sono negati server-side con record e audit invariati; i testi restano disponibili nel form.

## Correzione R04

Il lock parametrizzato della sessione registry applica il cast PostgreSQL `::uuid` già usato dal servizio canonico delle sessioni. Gli altri lock introdotti dal percorso operano su identificativi testuali (`User`, `UserPermissionOverride`, `Client`, `Project`, `Company` e `PreAnalysis`) e non richiedono il cast UUID.

## Correzione R05

Il form espone `data-preanalysis-form-ready=true` soltanto dopo il mount client e mantiene l'intero fieldset disabilitato fino a quel momento. Il browser attende questa prontezza locale dopo navigazioni, redirect, reload ed errori, e verifica il valore DOM esatto immediatamente prima di ogni submit di modifica. Questo impedisce che un `fill` iniziato durante l'idratazione venga riconciliato con il valore server, causa della concatenazione osservata su `scenarioA`.

## Allineamento UI permessi R06

Le pagine di creazione e dettaglio mostrano il form soltanto se coesistono `project.write` e il predicato canonico `canEditProject` sul progetto con cliente idratato. Revisori in sola lettura e backoffice con override del solo permission bit conservano la consultazione, ma vedono un messaggio chiaro e nessuna textarea o azione di salvataggio. Il browser verifica entrambe le pagine per i due profili, insieme all'invarianza di record e audit.
