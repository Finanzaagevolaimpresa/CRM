# R13 — Preferenze marketing: proposta dormiente e collaudo R23

## Prosecuzione R23

La Cabina R23 ha proposto la pubblicazione del ramo, una PR in bozza e i collaudi su GitHub Actions. La richiesta diretta di procedere è stata acquisita dalla Cabina R24. Questo perimetro supera il precedente limite alla consegna locale, senza autorizzare merge, rilascio, applicazione della proposta SQL alla produzione o collegamento del modulo al sito.

Il workflow `r13-marketing-preferences.yml` installa il lockfile, verifica che schema e 49 migrazioni operative siano invariati, esegue tutti e sette i casi PostgreSQL in uno schema temporaneo di un database sintetico dedicato, poi lint, unit test, typecheck e build. Il controllo fallisce in presenza di test SQL saltati. I risultati effettivi sono quelli del run associato all'HEAD della PR; la sola presenza del workflow non attesta il superamento delle prove.

I collaudi Chromium M1, M4 e M5 acquisiscono inoltre le viste S01–S08 richieste per i manuali. Le immagini provengono dall'applicazione esistente con utenti e pratiche sintetici, includono profilo, pagina, commit e impronta del PNG e rimangono artefatti CI separati dai manuali. Il collaboratore viene verificato anche con il profilo base e zero eccezioni di permesso. Le prove M4 registrano dichiarazioni sintetiche senza contattare provider o inviare email; non qualificano alcuna casella reale. Prima dell'integrazione nei manuali occorre controllare gli artefatti e il risultato del relativo job.

Le sezioni seguenti conservano le verifiche e i limiti storici delle consegne R13–R21. I riferimenti a zero test SQL eseguiti e all'assenza di pubblicazione descrivono quelle consegne, non un risultato della CI R23.

Mandato: Cabina R13, confermato da R14/R15 e dalla richiesta diretta di Antonio di realizzare la patch locale isolata. Correzione del fallback HTML acquisita dalla Cabina R16 dopo la consegna iniziale `137f5c1`. Base verificata su GitHub: `afcdaee5bc718088890a289997ad6fbd72433e79`, albero `3b4e4fffcadf155aa2206787ff24281e1d5ccb81`. Branch locale: `codex/marketing-preferences-r13`.

La patch aggiunge codice per ricostruire la preferenza corrente da un registro separato, acquisire blocchi e revoche senza riscrivere le ricevute N04, calcolare scadenze e impedire l'ammissione promozionale quando la situazione è incerta. Il codice non è collegato ai percorsi applicativi esistenti. Non sono state eseguite scritture su database, migrazioni, pubblicazioni, attivazioni o operazioni sul lead reale.

## Componenti e comportamento

| Componente | Risultato locale |
| --- | --- |
| `src/lib/marketing-preferences/policy.ts` | Contratto rigoroso degli eventi; riferimento email HMAC con chiave iniettata; mesi di calendario UTC; preferenza corrente; piano di conservazione con vincoli per contestazioni concrete. |
| `src/lib/marketing-preferences/service.ts` | Acquisizione della scelta da una ricevuta verificata; blocco pubblico precauzionale; revoca e cessazione registrate da un adattatore interno autorizzato; idempotenza; quarantena; selezione e controllo finale sotto lo stesso lock del contatto. |
| `src/lib/marketing-preferences/postgres-store.ts` | Adattatore Prisma con SQL parametrizzato e transazioni serializzabili, senza retry automatici. Verifica la catena ricevuta N04 → envelope originario → informativa. Salva il testo integrale dell'informativa nel nuovo evento. |
| `src/lib/marketing-preferences/withdrawal-http.ts` | Adattatore HTTP non montato: stesso sito, corpo limitato, controllo di ammissione iniettato obbligatorio, risposta uniforme e conferma solo dopo commit. La composizione runtime restituisce sempre `null`. |
| `src/components/marketing-withdrawal-form.tsx` | Componente pubblico non montato «Preferenze email», unico campo email e pulsante «Non inviarmi più email promozionali». POST anche come fallback HTML; nessun indirizzo nella query string. |
| `prisma/proposals/r13-marketing-preferences/migration.sql` | DDL proposto, separato dalla catena automatica delle migrazioni. Tre tabelle vuote e vincoli di immutabilità. |
| `tests/marketing-preferences-r13*.test.ts` | Prove sul codice applicativo e sul verificatore delle ricevute; archivio transazionale simulato e client Prisma simulato. |
| `tests/db/marketing-preferences-r13-db.test.ts` | Sette prove PostgreSQL predisposte, con opt-in e guardia esistente per database effimero su loopback. Non ancora eseguite. |

Il pubblico può registrare esclusivamente `SUPPRESSED`: richiesta non autenticata, con blocco precauzionale, senza attribuirle una prova di identità. L'API non crea lead. `WITHDRAWN` e `PURPOSE_CLOSED` richiedono l'adattatore interno con il riferimento dell'operatore; l'autorizzazione del chiamante dovrà essere composta dal percorso autenticato futuro. Nessuno di questi metodi è esposto da una route R13.

Il form senza JavaScript è supportato dal controller tramite `application/x-www-form-urlencoded`, oltre al JSON della versione interattiva. Il futuro host deve generare un UUID v4 per ogni nuova pagina non memorizzata in cache e passarlo come proprietà `requestId`: il componente lo rende in un campo nascosto, senza chiedere dati aggiuntivi alla persona. Un retry mantiene lo stesso identificativo e non rinnova l'evento. Dopo una conferma, la versione interattiva prepara un nuovo ID per una nuova eventuale richiesta. Il controller restituisce HTML per il POST nativo, con conferma successiva al commit, errore senza falsa conferma e link al percorso candidato `/preferenze-email/`. Email e informazioni sull'esistenza del contatto non sono riportate nella risposta. Il test completo serializza il form renderizzato e attraversa controller, archivio transazionale simulato e risposta HTML: non si limita al markup e non è un collaudo browser o SQL.

Il consenso positivo deriva esclusivamente da una ricevuta N04 legata a un `BusinessInboxEvent` integro. Il contatto proviene dall'email dell'envelope originario, non da `Lead.email`, che può cambiare. Il percorso legacy privo di email originaria immutabile viene rifiutato. Non sono previsti backfill o deduzioni sul lead manuale reale.

Una ricevuta valida non rende automaticamente il contatto ammissibile. Occorrono policy approvata, intervallo di efficacia valido, coppia esatta ID/hash dell'informativa qualificata per email, impronta della chiave coerente e attestazione recente della completezza della riconciliazione. L'epoch dell'attestazione deve corrispondere a quella registrata nel database. L'attestazione deve comprendere gli ingressi N04 e tutte le richieste di blocco; non può essere un semplice flag memorizzato. Il relativo fornitore di attestazioni non è implementato o configurato da questa patch.

L'attestazione e la selezione scadono al massimo dopo 60 secondi. Il controllo finale rilegge lo stato, verifica anche il destinatario e mantiene il lock del contatto durante il callback di consegna. Una revoca già confermata invalida la selezione precedente. Un errore dopo l'avvio del callback produce un esito incerto e vieta retry automatici; non equivale a mancato invio. Nessun provider reale è incluso o invocato. L'integrazione futura deve qualificare anche idempotenza del trasporto e confine effettivo della consegna.

## Scadenze proposte

I 24 mesi sono la proposta della Cabina R12, non un termine legale universale né una policy già approvata. `PROPOSED_POLICY.approvalReference` rimane `null`.

- Consenso: 24 mesi dall'evento esplicito originario, con giorno limitato alla fine del mese di destinazione e confine superiore escluso. Nessun rinnovo per aperture, clic, acquisti o replay.
- No, revoca e blocco: esclusione immediata; piano del riferimento negativo a 24 mesi dall'evento. La scadenza non produce consenso.
- Prova positiva: fine del ciclo, anche anticipata da una scelta successiva o dalla cessazione, più 24 mesi. Prova negativa: 24 mesi dall'evento.
- Contestazione: vincolo solo sugli eventi pertinenti, con riferimento, motivo, responsabile, riesame e condizione di rilascio. Un riesame scaduto mantiene il vincolo e lo segnala; un rilascio non sposta la scadenza ordinaria.

Il piano restituisce esclusivamente elementi da riesaminare, sempre `executable=false`. Non elimina o anonimizza dati. La futura conservazione controllata deve risolvere esplicitamente l'interazione con l'immutabilità delle prove e la permanenza del blocco, senza riattivare contatti. La conservazione dei moduli WordPress e delle copie di solo inoltro rimane nel dossier R43 e non viene implementata da R13.

## Migrazione e confini operativi

La proposta crea `MarketingPreferenceSubject`, `MarketingPreferenceEvent` e `MarketingPreferenceEpoch`. Il registro eventi è append-only e non troncabile. La revisione del soggetto avanza con il trigger dell'inserimento; la quarantena non può essere rimossa dall'API. I riferimenti N04 sono in sola lettura e protetti da chiavi esterne `RESTRICT`. L'epoch non viene popolata: le tabelle iniziano vuote, senza policy, consensi o credenziali.

Il file si trova in `prisma/proposals`, non in `prisma/migrations`. `schema.prisma` e tutte le 49 migrazioni operative restano identici alla base. `prisma migrate deploy` non applicherà questa proposta. L'adattatore usa SQL parametrizzato proprio per evitare di promuovere prematuramente i modelli nel client operativo.

Il riferimento HMAC del contatto è un dato pseudonimo personale. Il nuovo registro contiene inoltre metadati degli eventi, eventuale riferimento dell'operatore e testo pubblico dell'informativa; non conserva email in chiaro, IP, messaggi liberi del lead o dati di pagamento. Chiave e autorizzazioni non vengono provisionate. La futura rotazione della chiave e qualsiasi ripristino richiedono revoca dell'attestazione esterna, nuova epoch e riconciliazione verificata. La patch non rileva da sola un ripristino silenzioso dell'intero database: con composizione assente non esiste comunque ammissione live.

## Verifiche e riproduzione

Comando locale senza connessioni a database:

```powershell
node scripts/r13/run-local-tests.mjs
```

Lo script usa il compilatore TypeScript già previsto dal repository, compila anche il file dei test DB senza eseguirlo, poi esegue i test Node del codice compilato. Produce una directory locale distinta sotto `.next`; non installa dipendenze, legge credenziali, avvia container o elimina file.

Esito della consegna corretta R16: **29 test superati, 0 falliti, 0 saltati nella suite mirata**; compilazione TypeScript rigorosa dei componenti e dei test nuovi superata; ESLint sui file nuovi superato; controllo del diff senza errori. Coperti: revoca dopo selezione, reinvio immutabile, conflitto e quarantena persistente, ordine degli eventi, scelta negativa simultanea, ri-consenso esplicito, scadenze, vincoli di conservazione, ripristino dichiarato non riconciliato, attestazione scaduta, manomissione della catena N04, errore prima del commit e risposta pubblica uniforme. Due nuove prove coprono il flusso HTML senza JavaScript, compresi attesa del commit, errore di persistenza, replay, contatto sconosciuto e campi mancanti o duplicati.

Limiti concreti dell'ambiente: il registry npm è bloccato; le dipendenze disponibili sono state copiate nella sola copia isolata. TypeScript, tsx, Prisma, React e Zod corrispondono alle versioni richieste rilevate; la copia disponibile di Next/ESLint Next è 16.3.0, mentre il lock richiede 16.3.4, e manca `@playwright/test`. Il typecheck dell'intero repository non è qualificato per tali dipendenze mancanti. Il runner `tsx` locale fallisce inoltre su `os.userInfo`; il runner dedicato usa `tsc` e Node senza modificare tsx. Non viene dichiarata una verifica con installazione pulita del lockfile, una build completa o CI verde.

La verifica R16 di `npm ci --offline --ignore-scripts --no-audit --no-fund`, in una cartella di prova distinta dalla patch, è fallita con `EPERM` sull'accesso alla cache locale anche nel tentativo con escalation. La prova non ha contattato registry né sostituito le dipendenze usate dai test riusciti. `psql`, `initdb` e `pg_ctl` non sono stati trovati nel PATH o nelle due posizioni standard controllate: non è stato individuato un target PostgreSQL effimero qualificato, né avviato un container per crearlo.

Le **quattro prove SQL non sono state eseguite**: non è stato avviato o usato alcun database di test persistente. Il file `tests/db/marketing-preferences-r13-db.test.ts` richiede sia `RUN_R13_DB_TESTS=1` sia `RUN_DB_TESTS=1`, oltre a tutte le conferme, il nome database, il sentinel e l'identità loopback già richiesti dalla guardia del repository. Predispone uno schema sintetico distinto, applica schema49 e la proposta solo a quello schema, verifica atomicità, immutabilità e duplicati concorrenti. La loro esecuzione è necessaria prima di qualificare l'adattatore SQL.

## Passaggio successivo e recupero

### Collaudo browser locale R21

La prosecuzione R21 della Cabina ha richiesto prima il collaudo effettivo del modulo nel browser. È stato completato in Chrome, su server legato esclusivamente a `127.0.0.1`, con il componente React, il controller HTTP e il servizio della patch. L'archivio rimane quello transazionale sintetico in memoria: nessun database o provider viene usato.

Comando per avviare il banco e ottenere l'URL locale e il percorso dell'audit:

```powershell
node scripts/r13/browser-harness.mjs
```

Il banco compila le sorgenti con TypeScript e il client con il Webpack già incluso nella dipendenza Next disponibile; non esegue una build Next completa. Non installa pacchetti o legge configurazioni applicative. Le quattro pagine native non caricano JavaScript; le due interattive idratano il componente effettivo. Sono ammessi esclusivamente `recipient@r13.invalid` e `new@r13.invalid`. Le chiavi della fixture sono costanti sintetiche, senza collegamenti alla custodia reale.

Nel browser sono stati verificati sei casi, con nove POST complessivi: HTML con consenso iniziale, indirizzo sconosciuto, errore prima del commit, replay della stessa richiesta, React con seconda richiesta distinta, React con retry dopo errore. Verificati anche invio da tastiera, validazione nativa del campo email, disabilitazione del pulsante durante il salvataggio, conferma dopo commit, assenza di email nella risposta, ricevuta originale immutata e risposta HTML byte-identica per contatto noto e ignoto. L'audit del server è correlato agli stati osservati nel browser; le schermate sono conservate negli artefatti R21.

Sequenza riproducibile: una richiesta nei casi HTML noto, ignoto ed errore; due invii nello stesso caso replay tornando indietro nel browser; due invii successivi al completamento nel caso React di conferma; primo errore e secondo invio nel caso React di retry. Il verificatore rifiuta un audit incompleto:

```powershell
node scripts/r13/verify-browser-audit.mjs <percorso-browser-audit.json>
```

**Requisito dell'host emerso dal browser:** la pagina che rende il form deve preservare l'origine per il POST nativo nello stesso sito. Nel banco `Referrer-Policy: no-referrer` ha prodotto un rifiuto 403 senza registrare eventi; con `same-origin` il percorso è riuscito. Il controllo rigoroso `Origin` del controller rimane invariato; non accetta origini nulle come ripiego. La pagina futura va qualificata con i propri header effettivi. La differenza tra POST nativo e `fetch()` è documentata da [MDN, Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy). Nessuna configurazione del sito reale è stata modificata.

Ambiente del banco: Node 24.18.0, TypeScript 5.9.3, React 19.2.7, Webpack 5.98.0 incluso nel Next 16.3.0 disponibile. Il tentativo con esbuild si è fermato per accesso negato nella risoluzione dei percorsi; il banco usa ora direttamente il compilatore JavaScript disponibile. Questo esito non qualifica Next 16.3.4 richiesto dal lockfile.

Il residuo SQL è distinto. Alle quattro prove originarie sono stati aggiunti tre casi compilati: GRANTED/DENIED da ricevute N04 effettivamente persistite, rifiuto di informativa o decisione incoerente con la ricevuta, invalidazione di una selezione prima del callback finale dopo un blocco. Usano i servizi esistenti di ammissione e creazione delle prove privacy, senza inventare righe N04 o disattivarne i vincoli. **Sette test SQL predisposti, zero eseguiti.**

La ricerca del prerequisito R21 non ha individuato binari PostgreSQL nel runtime disponibile; Docker è inaccessibile anche nella verifica elevata. Il download portabile indicato dal sito ufficiale PostgreSQL è bloccato dalla allowlist di rete anche con esecuzione elevata. Nessuna istanza preesistente è stata utilizzata, nessun container avviato e nessuna migrazione eseguita. Serve un'istanza nuova, dedicata, effimera e sintetica raggiungibile con le guardie già previste; gli stessi tentativi falliti non vengono ripetuti.

Questo banco dimostra il modulo di revoca, non il CRM completo, il flusso WordPress o le viste dei quattro profili. Le schermate S01–S08 dei manuali restano da acquisire su un banco CRM qualificato.

Questa è una consegna locale proposta. Prima di una PR qualificata e di qualsiasi attivazione servono: installazione completa dal lockfile, prove PostgreSQL effettive, collegamento atomico o riconciliazione attestata degli ingressi N04, autorità e autenticazione dell'operatore, composizione del controllo di ammissione pubblico, custodia della chiave, policy e informativa approvate, qualifica del canale pubblico sul sito e del mittente finale. La pagina sul sito, la casella email e i percorsi WordPress non risultano qualificati da questa patch. Il precedente blocco degli accessi WordPress rimane rispettato.

Per recuperare il lavoro locale si conserva il commit e il diff esportato; non occorre alterare la produzione o annullare alcuna migrazione. Non è proposto un rollback distruttivo delle prove: l'eventuale schema futuro richiederà un piano specifico prima dell'applicazione. Checkout operativo, lead reale, Q05 originario e ricevute storiche rimangono preservati. Nessun push, PR, merge o deploy fa parte di questa consegna locale.
