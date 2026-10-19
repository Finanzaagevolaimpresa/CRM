# Registrare il servizio acquistato nel fascicolo

Da **Clienti → Apri fascicolo → Servizi acquistati → Registra servizio acquistato**, l’Admin sceglie il servizio del catalogo, un incarico firmato di quel cliente e la data dell’acquisto. Può collegare una rata già incassata oppure farlo in seguito tramite **Collega pagamento**. Il riepilogo mostra cliente, servizio, numero e attività dell’incarico, progetto e rata prima della conferma.

Se l’incarico manca, va registrato in Contratti e ne va completata la firma con il documento effettivo. Il catalogo definisce i servizi disponibili; consultarlo non li aggiunge al cliente. Il modulo non crea contratti, pagamenti, firme, offerte, concessioni, messaggi o assegnazioni.

La registrazione inserisce un ClientService in stato `richiesto`, senza responsabile. Il pagamento è ricavato dalla rata selezionata, mai da uno stato dichiarato nel form. Il progetto deriva dall’incarico. La successiva azione **Passaggio al tecnico** mantiene le verifiche esistenti di incarico, rata, documenti e file, la scelta del referente e la distinta presa in carico. Un servizio senza pagamento collegato può essere registrato ma non supera quei requisiti di affidamento.

Il collegamento successivo della rata è ammesso solo con pagamento assente, servizio richiesto/nuovo e nessuna pratica o ricevuta di passaggio. Non sostituisce un pagamento né sposta il servizio a un altro cliente, incarico, catalogo o progetto.

## Autorità, concorrenza e ricevute

Ogni caricamento, riepilogo, conferma e verifica dell’esito rilegge sessione registry, ruolo Admin, dinieghi espliciti su client.read/service.read/service.write/contract.read/payment.read e perimetri selettivi attuali. Anche concessioni revocate o non valide conservano le esclusioni. Clienti sospesi/cestinati e progetti archiviati/cestinati non sono ammessi.

La conferma usa una transazione serializzabile con i lock di directory, attore/sessione, cliente, servizio esistente, catalogo, incarico, rata e contesti progetto. Il fingerprint del riepilogo lega input, sessione e versioni correnti. Le modifiche concorrenti invalidano il riepilogo; nessun retry automatico applica una nuova intenzione. La coppia incarico/servizio di catalogo del cliente non viene registrata due volte, neanche da schede diverse, includendo i record storici/cestinati.

Un commandId identifica una sola operazione della stessa sessione. Il ClientService e la ricevuta tecnica minimizzata sono atomici; l’audit conserva identificatori e hash, senza nomi, importi, descrizioni o contenuti dei documenti. L’epoch del cliente viene incrementato nella stessa transazione per impedire che una verifica concorrente, rimasta in attesa del salvataggio, dichiari un falso esito assente con uno snapshot precedente. I conflitti richiedono una nuova lettura.

Il browser conserva soltanto il commandId in sessionStorage prima di inviare la conferma. Una risposta persa blocca altre conferme e offre **Verifica esito**, anche dopo ricarica. La verifica resta soggetta ai permessi correnti e non ripete la mutazione. Una risposta assente dopo riconciliazione consente un nuovo riepilogo. Nessun GET registra un servizio.

Dopo un collegamento pagamento già concluso, la stessa pagina resta disponibile per verificare la ricevuta in sospeso. Non carica nuove scelte né presenta il form di modifica; senza un comando da verificare rimanda al fascicolo. Revoche, cestino e perimetri correnti continuano a bloccare l’accesso. La conferma server non può sostituire il pagamento o applicare una nuova operazione su un servizio chiuso.

## Qualifica e rilascio

Schema 58 e tutte le migration restano invariati. La qualifica prevede 25 scenari PostgreSQL sintetici: registrazione, handoff esistente, collegamento successivo, doppio clic, schede concorrenti, risposta persa/in corso, rollback su errore audit, cambi di contesto, revoca e scadenza sessione, dinieghi espliciti, isolamento cliente/progetto e perimetri selettivi, riconciliazione del pagamento già collegato e dinieghi sulla pagina di sola verifica. Cinque scenari browser nativi coprono desktop, mobile, rata successiva, risposta persa con ricarica sia durante la registrazione sia durante il collegamento del pagamento e diniego a sessione aperta/URL diretto. Gli screenshot sono sintetici e non attestano operazioni reali.

Merge e rilascio app-only richiedono candidato esatto, CI verde, riesame indipendente pertinente, immagine del merge, preflight e postflight correnti. La registrazione di acquisti o assegnazioni reali è una decisione dell’utente nel CRM; non è una fixture del rilascio. Nessuna nuova migration, credenziale, autorità personale, provider o scheduler.
