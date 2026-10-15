# Condivisione selettiva del progetto — R01

Mandato 15 ottobre 2026, Cabina R09. Base di sviluppo: `c2948f387dfe7235bbdaf19f501b676cbf36aba2`, tree `1c3830103de0b9023da9d4f15bef7c15d6d5b825`. Il riferimento produttivo comunicato nel mandato resta PR185, source `69c78c52a335996dfbed3aae256d217d4644b89d`, schema49: non è una dichiarazione di deploy di questa modifica.

## Comportamento

Il titolare dell'autorità personale apre **Condividi accesso** dalla scheda progetto, sceglie una persona esistente, i campi e ogni versione documentale. Lo scaricamento richiede una scelta distinta per ciascuna versione. L'anteprima mostra la stessa proiezione usata dal destinatario e consente di consultare le versioni selezionate senza creare concessioni o sessioni impersonate. Prima della conferma vengono mostrati l'effetto sull'accesso precedente e il riepilogo.

La conferma richiede la sessione registrata, il controllo di sicurezza privilegiato esistente, una conferma personale esplicita e una preview firmata valida per cinque minuti. Qualsiasi variazione di progetto, destinatario, permessi, concessione o documenti tra anteprima e conferma richiede una nuova anteprima. Le conferme concorrenti non possono entrambe riuscire sulla stessa revisione.

Il destinatario trova **Progetti condivisi** nella navigazione. La scheda originaria del progetto restituisce la stessa selezione. Gli altri percorsi ordinari non espongono il contenuto del progetto sottoposto a questo limite. Gli altri utenti e gli altri progetti mantengono i propri controlli ordinari: il perimetro è la coppia progetto/destinatario, non l'intero cliente.

## Identità e dati

`SelectiveAccessAuthority` associa l'autorità personale a un ID utente, con revisione e abilitazione esplicite. Nessun nome visualizzato, email, semplice ruolo Admin o account commerciale può sostituire questo riferimento. L'identità reale è stata riconciliata nel mandato della chat esecutiva; non viene incorporata nel repository. La migrazione lascia questa tabella vuota. Il collegamento in produzione richiederà un'operazione separatamente autorizzata; questa PR non lo effettua.

`SelectiveProjectGrant` conserva selezione, versioni e metadati approvati, revisione, scadenza, approvatore e prova firmata. La stessa chiave registrata per il controllo privilegiato firma prove con domini distinti per preview e concessione. Una rotazione o indisponibilità della chiave rende indisponibile l'accesso selettivo finché non viene nuovamente approvato; non ripristina permessi ordinari.

La migrazione50 è additiva e non converte alcun progetto. I primi 49 file di migrazione restano immutati. I controlli CI qualificano il candidato corrente su schema50; i kit produttivi storici non sono modificati né estesi al nuovo schema.

## Controlli

- La selezione è un catalogo chiuso di campi. Nuovi campi, documenti e versioni non vengono inclusi automaticamente.
- I controlli ordinari di progetto, servizio, documento, attività, checklist, pratica, dossier e output AI negano il contesto limitato prima delle eccezioni di ruolo o assegnazione. Le concessioni cliente non ampliano la selezione.
- Sono filtrati anche contatori cliente, audit, report, autorizzazioni AI e code di assegnazione. Il percorso alternativo di download dei revisori non aggira il limite.
- Nessuna modifica, assegnazione, caricamento, invio o approvazione operativa viene conferita dalla selezione.
- Compensi, margini, pagamenti e note private non fanno parte del catalogo. I documenti finanziari e privati sono esclusi; i vincoli sui documenti sensibili restano applicati al destinatario.
- Ogni richiesta di file rilegge sessione, autorità, concessione, scadenza, ricevuta audit e checksum della versione. Le risposte sono `private, no-store`; non vengono restituiti URL permanenti allo storage.
- Concessione e audit sono nella stessa transazione serializzabile. Anche un errore di audit durante la consultazione impedisce di restituire i byte.
- La revoca conserva il perimetro e incrementa la revisione. Un trigger impedisce cancellazione e spostamento della coppia progetto/destinatario. Scadenza, revoca o prove non valide negano nuove richieste anche con una sessione già aperta.

## Limiti espliciti

La consultazione documentale di questo incremento supporta PDF, testo semplice, PNG e JPEG. Le altre tipologie non sono selezionabili. I metadati mostrati restano quelli approvati; il contenuto deve corrispondere al checksum della versione.

Il controllo di scaricamento autorizza l'operazione esplicita di download. Come per qualsiasi contenuto visualizzato, non costituisce DRM e non impedisce catture o copie da parte di chi lo ha già ricevuto. Revoca e scadenza non rimuovono dati già visualizzati o copiati.

Le tabelle del perimetro devono essere presenti prima dell'avvio del candidato. Nessun errore di lettura del nuovo schema viene convertito in accesso ordinario.

## Verifica e recuperabilità

La workflow `Selective project access` usa PostgreSQL16 effimero, database `fai_crm_test`, sentinella obbligatoria e dati sintetici. Verifica migrazione49→50, errore SQL iniettato con rollback completo, prefisso49 invariato, otto scenari PostgreSQL e due percorsi Playwright con utenti distinti, preview, conferma, URL diretti e revoca da sessione aperta. Gli artifact riportano HEAD/tree, TAP, ricevute e screenshot.

Il riesame del candidato iniziale ha richiesto quattro regressioni aggiuntive: le azioni reali sulle pratiche tecniche e sulle note interne ricontrollano il contesto corrente anche nella transazione; i moduli acquisiti prima della concessione restano negati dopo concessione e revoca, sia per Admin sia per tecnico assegnato. L'esito di ogni operazione selettiva ricontrolla la scadenza persistita e quella dichiarata usando l'orologio corrente PostgreSQL, dopo le attese e prima del commit o della restituzione dei byte; un diniego annulla anche l'audit operativo. Il filtro audit comprende gli ID canonici dei messaggi M4 e delle risposte collegate. Un contratto finanziario comune resta riservato senza estendere il perimetro ai servizi, documenti e attività di un altro progetto.

Comandi pertinenti: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `node --import tsx --test --test-reporter=tap tests/selective-project-policy.test.ts`, il test PostgreSQL `tests/selective-project-access-db.test.ts` e Playwright con `tests/selective-sharing/playwright.config.ts`. I test DB richiedono il guardiano di isolamento esistente; non devono essere indirizzati a database reali.

Una versione precedente che ignora `SelectiveProjectGrant` **non è un rollback sicuro**. Con perimetri presenti il recupero deve mantenere schema50, i record permanenti, i controlli di esclusione e le prove di revoca. La procedura ammessa è correggere in avanti oppure usare una versione che conserva questi controlli. Un eventuale blocco d'emergenza dell'autorità deve mantenere i perimetri ed essere autorizzato come modifica di permessi reali. Non cancellare le concessioni e non ripristinare schema49 per recuperare l'applicazione. Nessuna di queste operazioni produttive è inclusa nella consegna R01.

La qualifica del pacchetto usa la stessa revisione per il riavvio e il rientro, con una concessione sintetica attiva e una revocata. Verifica la selezione e il divieto di ripristinare accessi ordinari prima e dopo il riavvio, oltre alla conservazione delle impronte di schema, documenti, autorità, concessioni e ricevute. Non dimostra che un errore del codice sia risolvibile riavviando lo stesso codice: in quel caso occorre una correzione compatibile verificata. La vecchia immagine M1 non è più ammessa come destinazione del candidato schema50.

La PR resta da qualificare finché CI e riscontri UI non sono verdi sull'ultimo HEAD. Nessun merge, deploy o modifica produttiva è eseguito dalla consegna.
