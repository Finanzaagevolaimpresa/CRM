# Automazioni, email e integrazioni

Mandato `FAI-CRM-FLUSSO-OPERATIVO-20261126-R01`, baseline PR262 `c9c0b8d830f05d9f62e975be2b760214e879ee8c`.

## Percorso Admin

In **Automazioni** crea il testo in **Modelli email autorizzati**, indica l’uso (conferma, sollecito, appuntamento, documenti, newsletter, avviso interno) e salva una bozza. La pubblicazione richiede il riferimento alla decisione che autorizza il testo. Una modifica produce una nuova versione; una duplicazione produce una famiglia indipendente. Le regole già salvate mantengono l’esatta versione selezionata.

Scegli evento, modello iniziale, eventuale passaggio successivo e attesa. Per l’acquisizione il lead deve essere già associato alla ricevuta. Risposta e appuntamento interrompono il sollecito. L’appuntamento ha invece conferma e promemoria propri: l’attesa indica quanti minuti prima dell’inizio preparare il promemoria. **Pronta per prova** consente la qualificazione interna. **Attiva** rimane indisponibile finché un rilascio autorizzato abilita la preparazione nativa. Il registro distingue test superato, versione della regola e singoli casi verificati.

La scheda Lead riunisce le comunicazioni già autorizzate e lo stato delle esecuzioni: in attesa, accettata nel canale di prova, incerta, errore o interrotta. Le ricevute esistenti restano nel proprio percorso. “Accettata dal server” non equivale a consegna al destinatario.

## Prova persistente

Nel solo ambiente `APP_ENV=test`, con database locale `fai_crm_test` marcato `FAI_CRM_EPHEMERAL_TEST_ONLY_V1` e conferme di test già previste dal repository, l’Admin può scegliere dalla scheda una ricevuta e una regola pronta. **Registra sequenza e prova conferma** crea l’iscrizione, due passi se è previsto il sollecito e la ricevuta dell’outbox sintetica. L’indirizzo destinatario deve terminare in `.test` o `.invalid`. Nessuna implementazione di questo comando apre una connessione SMTP.

L’iscrizione rilegge evento canonico, impronta, stato `PROCESSED`, identità risolta e scheda corrente. Il vincolo regola/evento impedisce iscrizioni duplicate. I passi e le ricevute hanno chiavi stabili. Le esecuzioni concorrenti si serializzano sul lead e sull’iscrizione. Solo un errore di transazione certamente annullata ammette una ripetizione automatica; l’esito incerto richiede riconciliazione esplicita.

I punti nativi di risposta email, contatto effettivo e prenotazione fermano i solleciti nella stessa transazione del dato che li giustifica. La ricevuta della conferma rimane conservata. La consultazione ricontrolla l’accesso attuale alla scheda: una riassegnazione non lascia la timeline al precedente referente.

Il planner interno usa gli stessi binding per iscrizioni sintetiche e native. `WORKFLOW_NATIVE_PREPARATION_MODE` è disabilitato per default e non è modificato da questa consegna. Il ramo nativo richiede regola `ACTIVE`, prepara una sola bozza per passo nel sistema email esistente e conserva stato `PREPARED`, distinto da `SENT`. Autorizzazione, mittente e invio restano nei controlli email nativi. La riconciliazione verifica la revisione esatta e l’evidenza di `CommunicationAttempt` oppure la ricevuta SMTP nativa; una bozza o un esito incerto non autorizzano il sollecito. Anche un sollecito già preparato viene fermato: le nuove approvazioni e ammissioni di invio rileggono lo stato della sequenza, mentre consultazione e registrazione di un esito già iniziato rimangono disponibili.

Sono cablati due ingressi dormienti dopo il commit della proiezione e della risoluzione duplicati. Quando il gate sarà autorizzato, registreranno l’intento per l’unica regola di acquisizione attiva dell’attuale autorità email nativa. Più regole candidate o autorità non valida producono un blocco consultabile. Il confronto temporale usa la risoluzione effettiva per un’identità precedentemente in revisione; non importa automaticamente ricevute concluse prima dell’attivazione della regola. Un errore di acquisizione dell’intento non annulla la ricevuta o la proiezione già completata. Il comando **Prepara i passaggi in attesa**, in Automazioni, recupera eventuali intenti mancanti dal registro durevole e prepara le bozze con la sessione attuale dell’autorità qualificata. Non è uno scheduler e non invia email.

Gli altri ingressi sono comandi espliciti della scheda, disponibili per le regole pronte nel database sintetico e, dopo autorizzazione del gate, per le regole native attive. L’appuntamento è legato a ID, versione e titolare del calendario; l’assegnazione all’attività o decisione corrente; il cambio di stato all’evento immutabile prodotto dal sistema nativo degli aggiornamenti; la richiesta documenti al comando e all’elenco immutabile dell’operatore. Il comando rilegge accesso, referente e versione della scheda. Spostamento, annullamento, riassegnazione o evento superato fermano il passaggio non più valido; il replay dello stesso evento non crea una seconda iscrizione. Questi ingressi non introducono nuovi automatismi attivi sui cambi di stato.

L’azione **Avviso interno** conserva una ricevuta per il destinatario corrente, con relazione al suo utente. Entra nello stesso elenco e contatore delle notifiche native; l’apertura idempotente conserva la voce nelle Lette senza completare l’attività. Una riassegnazione revoca anche la consultazione delle ricevute indirizzate al precedente referente. L’avviso rimane distinto dall’email e non usa un mittente esterno.

## Newsletter e preferenze

La vista **Newsletter** separa programmazione e destinatari proposti dalle sequenze individuali. La data è risolta nel fuso `Europe/Rome`; gli orari inesistenti o ambigui sono respinti. La selezione non attribuisce consenso. Il modello richiede `{{unsubscribeUrl}}`. Ogni prova persistita conserva versione, destinatari, template, policy e stato per destinatario in `WorkflowNewsletterRun` e `WorkflowNewsletterRecipient`. Due schede con la stessa email non causano due invii nello stesso run.

Il registro R13 verifica consenso da ricevuta immutabile, testo dell’informativa e email originaria. `MarketingPreferences.select` controlla le preferenze attuali; `atFinalHandoff` le ricontrolla al confine della consegna. Il claim `SENDING` viene salvato prima del trasporto: replay e processi concorrenti non ripetono l’effetto. Un crash o esito incerto richiede riconciliazione con evidenza; dopo un esito negativo accertato, il tentativo successivo rilegge consenso e disiscrizione. Le ricevute precedenti restano nello storico.

La migration78 include le tre tabelle e gli invarianti della proposta R13 senza provisionare policy, chiave o epoch. Nel solo database sintetico il collaudo registra un consenso verificato, ne prova la selezione, acquisisce la disiscrizione tramite l’adapter HTTP esistente e verifica l’esclusione. Il coordinatore di test mantiene l’esclusione della preferenza fino alla persistenza del risultato dell’outbox; non qualifica un provider esterno.

L’esecuzione reale richiede ancora una composizione autorizzata del mittente, un coordinatore di handoff qualificato, la policy approvata e la pubblicazione della disiscrizione. `PostgresPreferenceStore` da solo non abilita handoff esterni e `marketingWithdrawalRuntime()` resta `null`. La UI distingue una configurazione salvata da una prova effettivamente eseguita; i blocchi per destinatario restano visibili.

## Censimento HighLevel

| Voce riferita/osservata | Uso da qualificare | Dipendenze non acquisite |
| --- | --- | --- |
| Assegnazioni lead | evento, referente, avviso | condizioni esatte e destinatari |
| Documenti aggiuntivi preanalisi | richiesta e sollecito | testi, elenco documenti, stop |
| Automazioni interne | avvisi e cambi di stato | inventario di trigger/azioni |
| Messaggi Automatici | conferme e promemoria | modelli autorizzati e canali |
| Cold Emailing | valutazione separata | finalità, selezione, policy e provider |
| SiDial | valutazione telefonia | contratto, API e dipendenze |

Antonio riferisce 32 modelli. Il numero non attesta che i testi siano stati esportati, approvati o importati. Nessun testo aziendale è precompilato per supposizione. I test usano esclusivamente testi esplicitamente sintetici.

Il candidato comprende gli adapter persistenti per acquisizione, appuntamenti, richieste documenti, assegnazioni, cambi di stato e avvisi interni. Restano da acquisire le condizioni e i testi aziendali autorizzati delle sequenze HighLevel: il censimento non abilita né importa flussi reali. Le email native rimangono soggette all’approvazione del messaggio esatto; una sequenza automatica con invio esterno senza tale passaggio richiede una distinta autorità qualificata.

Il riferimento funzionale distingue trigger e azioni e raccomanda verifica delle condizioni e della cronologia: [Workflow HighLevel](https://help.gohighlevel.com/support/solutions/articles/155000002288-getting-started-with-workflows). Anche le metriche di accettazione, consegna, risposta, clic e disiscrizione dipendono dalle evidenze disponibili: [Statistiche email HighLevel](https://help.gohighlevel.com/support/solutions/articles/155000003902-how-to-analyze-workflow-campaigns-in-highlevel). Interfaccia e implementazione FAI sono originali.

## Confini della consegna

Nessun worker, scheduler, cron o provider viene attivato. Non viene creato un nuovo numero WhatsApp. La pagina **Impostazioni → Integrazioni** espone capacità, responsabile, ultima ricezione o prova attestata senza trasformare una configurazione in prova di funzionamento. L’accesso effettivo Drive si verifica con il ruolo; Google Calendar conserva prove distinte per persona. API Tek01, piano, ambiente di prova e costi restano da confermare.

Verifiche dedicate: `node --import tsx --test tests/workflow-automation.test.ts`, quindi sul database sintetico preparato `node --import tsx --test --test-concurrency=1 tests/workflow/persistence.ts tests/workflow/native-preparation-persistence.ts tests/workflow/newsletter-persistence.ts tests/workflow/operational-events-persistence.ts tests/operational-flow/persistence.ts`. La suite ha 19 casi persistenti: acquisizione/stop/riconciliazione, preparazione nativa e recupero, newsletter/preferenze, quattro eventi operativi ed E2E fino alla proforma.

Su Linux l’E2E attraversa il vero handler HTTP con firma HMAC e chiavi esclusivamente sintetiche, verifica il replay con un’unica richiesta/ricevuta e usa la proiezione identità nativa. Su Windows ricevuta e proiezione sono fixture dichiarate perché i lettori delle chiavi richiedono POSIX0600; l’inbox e i passaggi successivi sono nativi. L’evidenza registra esplicitamente il percorso usato. La prova Windows non attesta l’HTTP/HMAC; il ramo Linux deve superare il proprio job CI, oltre alle suite dedicate del connettore. L’E2E produce PDF e `evidence.json` in `generated/operational-flow` (oppure `OPERATIONAL_FLOW_EVIDENCE_DIR`). Nessuna prova apre il trasporto di un provider reale.
