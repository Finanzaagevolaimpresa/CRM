# PRELANCIO02 — sito, richiesta CRM e presa in carico

## Scopo del delta

La filiera e le schermate sono già implementate. La prova N14 sul candidato
terminava alla prima risposta commerciale: non dimostrava la conferma personale
del referente e la prossima azione datata sul lead nato da WPForms.
Questo incremento estende quel banco e corregge un errore del connector: un
fallimento di cattura successivo alla validazione WPForms era soltanto nel log,
mentre l'utente poteva vedere la conferma di invio. Il connector 1.2.1 registra
l'errore nel processore WPForms e impedisce il redirect di conferma della sola
richiesta fallita. Il modulo conserva i valori per la correzione; il messaggio
parla di esito non confermato, senza asserire che un enqueue incerto non esista.
Schema, dipendenze, applicazione CRM, contatori, menu e logo restano invariati.

Assegnazione amministrativa, presa in carico personale, prima risposta e prossima
azione sono registrazioni distinte. Il test non le sostituisce l'una con l'altra.
Le date future e lo SLA di 24 ore del banco sono fixture sintetiche, non impegni
commerciali approvati.

## Percorso esistente e osservabili

1. Il callback WPForms validato alimenta la coda cifrata InnoDB del connector
   `fai-secure-lead-connector` 1.2.1. La conferma del form, da sola, non prova
   l'ingresso nel CRM.
2. Il worker finito invia l'envelope N10 firmato a
   `POST /api/integrations/website/leads/v2`. N12 restituisce la ricevuta solo dopo
   persistenza di N11. La ricevuta pubblica e l'ID interno dell'evento sono
   identificatori diversi; la correlazione passa da `SecureLeadGatewayReceipt`.
3. Il consumer finito VNX01, o il pilot VNX05 circoscritto a precisi ID di riga,
   proietta N13 e conserva contenuto originale, provenienza e prove privacy.
   Il replay non crea una seconda richiesta. Un nuovo invio dello stesso contatto
   può richiedere una decisione nella coda duplicati: non viene scartato e il
   collegamento all'esistente non ne sovrascrive contenuto o campagna.
4. Con N14 esplicitamente abilitato e policy ACTIVE valida, la proiezione crea
   l'item e la scadenza di prima risposta. L'Admin assegna dalla Commercial Lead
   Inbox; la decisione `responsibility_assigned` indica il referente individuale.
5. Il referente apre il lead → **Responsabilità e presa in carico** →
   **Confermo la presa in carico commerciale**. L'audit `responsibility_accepted`
   è riferito alla precisa decisione corrente. L'Admin non può confermare per lui.
6. Dalla scheda lead, **Aggiorna pipeline commerciale** salva nota e data della
   prossima azione. La scadenza è rileggibile nella scheda e nell'elenco Lead.
   La pagina generale `/deadlines` è ancora una vista in preparazione: non viene
   presentata come calendario di intake qualificato da questo incremento.

## Matrice delle prove

| Requisito | Prova effettiva |
| --- | --- |
| WPForms → ricevuta → evento → proiezione → item | `tests/vnx03/n14-commercial-browser.spec.ts` e `assert-n14-state.ts`: browser autentico, consumer reale nel banco isolato, correlazione persistita e privacy servizio ACKNOWLEDGED / marketing DENIED |
| Assegnazione e conflitto | Stesso banco N14: due azioni Admin concorrenti, un solo aggiornamento, errore di versione verificato e ripresa browser |
| Presa in carico esplicita | Nuovo tratto N14: nessuna accettazione dopo assegnazione/prima risposta, azione del referente, audit legato alla decisione, persistenza dopo reload |
| Replay accettazione e identità esclusa | Replay dell'azione React effettiva; stessa persona idempotente, Admin e altro commerciale negati con messaggio specifico; hash dell'intero stato pertinente e audit invariati |
| Prossima azione e scadenza | Modulo reale, reload, elenco Lead, `nextActionNote`, `nextActionDate`, alias `nextAction` e audit `lead_update` dell'owner; fixture UTC esplicita |
| Risposta persa e retry sito | Banco `wpforms-https-e2e.spec.ts`: drop dopo persistenza, coda PENDING, stesso evento/receipt al retry, nuovo nonce senza duplicazione |
| Nuova richiesta dello stesso contatto | Test PostgreSQL M3 `multiple submissions retain original campaign, request and privacy after replay and manual identity resolution`: due richieste, un lead, verifica coda AMBIGUOUS e collegamento senza overwrite |
| Errore recuperabile/terminale | Test PostgreSQL M3 `retry and terminal errors stay visible while successful recovery removes only the open error`; cronologia tentativi conservata |
| Richiesta incompleta e cattura fallita | Banco WPForms aggiornato: privacy mancante e chiave sintetica di coda indisponibile; errore visibile, nessuna conferma, valori conservati, zero ammissioni; casi message/redirect/AJAX e correzione successiva del modulo. Test PHP per default-off, form escluso, configurazione/queue errate e isolamento dell'errore per form |
| Isolamento ruoli | Accesso negato al secondo commerciale nel banco N14, lettura provenienza senza dettagli privacy per il commerciale; ulteriori regressioni M3 esistenti |

Esecuzione prevista: workflow esistente **R05 N14 exact candidate**, che verifica
HEAD/tree/schema49, esegue il banco sintetico e controlla anche le nuove ricevute
`personalAcceptanceBrowserCompleted` e `datedNextActionBrowserCompleted`.
La CI generale mantiene le prove PostgreSQL M3 e tutte le soglie correnti.
L'esito è attestato dai run del candidato, non dalla sola presenza dei test.

Artefatti aggiunti al banco: `n14-personal-handoff.json`,
`n14-personal-acceptance.png`, `n14-next-action.png`; solo fixture sintetiche.
Le richieste React catturate rimangono in memoria: non si salvano cookie,
password, token di sessione o corpi delle azioni nelle evidenze.

Il comportamento WPForms è stato verificato staticamente sull'archivio ufficiale
2.0.1.1 vincolato dal banco (SHA256
`6245074790df01a6e24a42587e024132b4a28fac499d1a8fa12ebf5580e4852b`):
`WPForms_Process::ajax_submit` rilegge gli errori dopo il callback;
`Frontend::output_success` richiede l'assenza di errori; il filtro
`wpforms_process_entry_confirmation_redirect_confirmations` evita l'uscita
anticipata verso una pagina di conferma. Nessuno spostamento dell'enqueue prima
della validazione, nessuna modifica a identità, cifratura, schema di coda o worker.

Limite esplicito: il callback è successivo al salvataggio/notifiche WPForms.
La correzione non rende atomici eventuali invii o pagamenti di altri plugin.
Il target operativo è il modulo di richiesta; notifiche, plugin e configurazione
reali devono essere inventariati prima del cutover. Un browser che perde la
risposta resta un esito incerto: non si promette deduplicazione automatica di un
nuovo invio Lite, distinto dal retry dello stesso evento già in coda.

## Raccordo pubblico rilevato l'8 ottobre 2026

Le letture GET ordinarie dall'MSI alle 16:03 UTC restituiscono HTTP200 per
`/contatti/`, `/verifica-ai-essenziale/` e `/privacy-policy/`.
Entrambe le prime due pagine espongono `wpforms-form-1265` con gli stessi campi
operativi noti. Questo aggiorna il precedente limite documentale sull'equivalenza
del modulo incorporato, ma non decide quale URL sia la destinazione ads finale.
Non è stata eseguita alcuna submission pubblica o accesso amministrativo WP.

Riutilizzare [Q05 e mapping già acquisiti](prelancio-01-acquisizione-r01.md):
nome composto 1, email 2, telefono 3, azienda/progetto 4, servizio 5,
obiettivo 9 e parti testuali configurate. Il campo 13 contiene fasce/importo
indicativo, non un importo numerico da inventare. Il 19 riguarda la privacy
di servizio, il 109 la dichiarazione B2B. Il campo 16 è ausiliario: le sue label
pubbliche variabili non diventano dati del progetto.

La scelta Q05 Sì/No, senza default e con invio ammesso scegliendo No, è già
acquisita per la preparazione. Il form pubblico osservato non espone ancora
questa scelta marketing; il 110 resta una fixture, non un ID live. Assenza della
risposta e DENIED restano stati distinti. Nessun testo canonico, efficacia o
registrazione privacy viene dedotto dall'hash del corpo HTML di una pagina.

## Confine operativo ancora da decidere

Il runtime PR185 è già distribuito. La lettura autorizzata delle 16:03 UTC
riconferma source `69c78c52a335996dfbed3aae256d217d4644b89d`, schema49,
app/PostgreSQL healthy e `FEATURE_INTEGRATIONS_ENABLED=false` con gate DB falso.
Gateway, N14 e consumer non sono configurati per l'attivazione; registri notice,
chiavi gateway/identità, policy N14, receipt, inbox e projection risultano vuoti.
È una prova di mancata attivazione, non un difetto del rilascio PR185.

Per una decisione eseguibile occorrono, in un solo raccordo:

- destinazione finale della campagna e versione del form1265 da collegare;
- referente amministrativo WordPress/hosting e canale autorizzato per inventario,
  backup e installazione; il precedente diniego privato e la sospensione SQLWP
  restano validi, senza dedurre che WordPress risieda sul VPS CRM;
- testi canonici approvati delle informative, identità/versione/hash/efficacia e
  registrazione delle finalità servizio/marketing; i codici `pilot-v1` preesistenti
  restano candidature;
- responsabile operativo e policy N14 approvata: ID/versione, ACTIVE, modalità,
  clock e target di risposta. Nessuno SLA numerico del test diventa un default;
- autorizzazione puntuale a configurazione plugin/coda/chiavi, registri/gate CRM,
  consumer finito selezionato e prova pubblica sintetica concordata.

La sequenza e il recupero saranno vincolati agli accessi e alle identità così
attestati: inventario/backup, preparazione chiavi senza esposizione, ammissione
registri, connector inizialmente disabilitato, verifiche, cutover del solo modulo,
singola prova con correlazione fino a owner/accettazione/azione. Replay e nuova
richiesta rimangono prove distinte; no scheduler generico o invii marketing.
In caso di fallimento, sospendere i nuovi ingressi/consumer secondo il piano
approvato e conservare coda/receipt per riconciliazione; niente cancellazioni o
replay ciechi. Un ritorno di configurazione richiede il backup e l'autorità
specifici, non un rollback automatico desunto da questa qualifica.

Questo documento e la CI non autorizzano merge, deploy o attivazioni. Il delta
del connector richiede una futura installazione WordPress specificamente
autorizzata; non serve una nuova immagine CRM per le schermate già rilasciate.
Il completamento operativo
resta distinto dal PASS della qualifica sintetica.
