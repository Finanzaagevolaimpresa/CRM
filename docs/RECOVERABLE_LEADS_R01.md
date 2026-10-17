# Cestino e ripristino lead — R01

Primo incremento dell'incarico ADMIN, COMUNICAZIONI, AGGIORNAMENTI E VIDEO del 17 ottobre 2026. Base `96599348318c783e23195cf1ba04ffc0027ebd0f`, schema51. Il presente documento descrive il candidato; disponibilità produttiva e prove sull'HEAD esatto sono registrate nella PR e nel checkpoint della delivery.

## Percorso dell'utente

L'Admin con i permessi correnti `lead.read` e `lead.write` trova **Sposta nel cestino** nella lista Lead e nella scheda. Il modulo mostra il lead e le conseguenze, richiede una casella di conferma e permette un motivo facoltativo a scelta. La conferma personale privilegiata dura cinque minuti e viene verificata nuovamente nella transazione. Non viene creato un binding personale o riutilizzato il binding email.

**Lead → Cestino** è riservato all'Admin e mostra soltanto identità, data e stato conservato dei lead rimossi. **Ripristina lead** richiede una nuova conferma esplicita e riporta il lead al suo stato commerciale e alle sue assegnazioni precedenti. Il ripristino non azzera scadenze già superate. Non esistono eliminazione definitiva, cascata o svuotamento programmato.

Il cliente già convertito resta utilizzabile con i diritti correnti. Offerte, documenti/versioni, richieste originali del sito, consensi/revoche, attribuzioni e cronologia rimangono conservati. Le operazioni dipendenti dal lead sono sospese mentre è nel cestino; i documenti del cliente indipendenti dal lead conservano il proprio perimetro.

## Enforcement e conservazione

- Lista, scheda, anagrafica, ricerche, dashboard, contatori, inbox, notifiche, offerte/esportazioni e readiness escludono i lead nel cestino. L'audit storico resta conservato secondo i permessi esistenti.
- La transizione modifica soltanto `Lead.deletedAt` e una versione `updatedAt` monotona. Il comando usa la versione esatta del modulo. Conversione, aggiornamento e mutazioni delle risorse dipendenti acquisiscono il lock sul lead e ricontrollano lo stato.
- L'aggregato N14 incrementa soltanto la versione del comando. Disponibilità, presa in carico, prima risposta, ciclo SLA, scadenza e stato restano invariati. Un vecchio comando N14 non torna valido dopo il ripristino.
- La transazione serializzabile rilegge sessione, ruolo e permessi; controlla scadenza sul clock DB e prova personale anche prima della conclusione. Stato e audit `lead_lifecycle_changed` sono atomici. Il minimizzatore nativo conserva solo attore/identificativo, stato, azione, versione, data e codice motivo, senza contenuti del lead.
- Vecchie anteprime e approvazioni email readiness sono invalidate dalla ricevuta di lifecycle. Le righe storiche restano immutate. Dopo il ripristino serve una nuova decisione personale sulla versione esatta; concessioni, consensi e scadenze non vengono rinnovati.
- Nessun retry automatico del browser dopo un esito incerto. Ricaricare per verificare lo stato; una richiesta duplicata o precedente viene rifiutata.

## Nuove richieste e duplicati

La chiave di serializzazione dell'identità è condivisa con creazione manuale, profili e proiezione del sito. La ricerca dei duplicati include le identità nel cestino senza renderle consultabili o selezionabili nella coda ordinaria.

Nel percorso corrente del sito una nuova richiesta coincidente rimane durevolmente in `REVIEW_REQUIRED`, con payload originale e prove privacy. Non aggiorna né ricrea il lead nascosto. Il replay mantiene la ricevuta originale. Creare un lead distinto richiede il separato flusso esplicito di risoluzione; non avviene in automatico.

Il vecchio percorso legacy non possiede un payload durevole indipendente dal lead: una nuova richiesta coincidente restituisce `409` e annulla la transazione, senza dichiararla acquisita o perdere silenziosamente il testo. Il replay già completato resta idempotente. Non viene modificata la modalità del provider o del sito.

## Qualificazione del candidato

- Typecheck, lint, unit test e regressioni del repository.
- `tests/lead-lifecycle-db.test.ts`: dieci prove PostgreSQL sintetiche su conservazione, audit nativo/errore atomico, replay, concorrenza, permessi/sessioni, comandi N14 e accessi indiretti.
- `tests/lead-lifecycle/lifecycle.spec.ts`: tre percorsi browser nativi su lista/scheda/cestino, desktop/mobile, sessione aperta/revocata, risposta persa, replay, URL ed esportazioni. Il workflow **Recoverable leads** esegue PostgreSQL e browser sull'HEAD esatto, senza dati reali.
- Le suite N13/N01 esercitano nuove richieste e replay del sito; la suite email esercita l'invalidazione delle anteprime e delle approvazioni dopo cestino/ripristino.
- PR140 verifica nell'immagine confezionata, al primo avvio e dopo riavvio/ripresa, l'esclusione del lead rimosso, l'accesso al cliente conservato e al lead ripristinato. Impronte di lead, ricevute, inbox e cicli SLA devono rimanere identiche.

## Rilascio e recuperabilità

Nessuna migration: schema, 51 file SQL storici e dipendenze restano invariati. Il rilascio è app-only dopo CI verde e PASS pertinente del revisore esistente sul candidato esatto. Prima del cutover: riconfermare main/merge/genitori/tree, immagine qualificata del merge, schema51, registry/sessioni, canali email e inbound, perimetri, health e compatibilità del piano di recupero.

Una versione precedente che ignori il cestino, le versioni N14 o le ricevute di lifecycle non è un ritorno compatibile dopo il primo utilizzo. Qualificare il riavvio della medesima immagine o una correzione che mantenga tutti i controlli. Nessun down-migrate, ripristino automatico di grant, revoca di sessioni reali o nuovo backup è implicito nel candidato. Il preflight deve trattare le sessioni produttive secondo il gate già esistente, senza modificarne le ricevute.

Il postflight comprende identità runtime/source/tree/immagine/schema, health, invarianti e visibilità dei nuovi percorsi con account autorizzato. Nessun lead reale viene usato come fixture; nessun invio email, attivazione provider/cron o nuova concessione è autorizzato da queste prove. Email nei nuovi contesti, Chi aggiornare e Video hanno incrementi successivi distinti.
