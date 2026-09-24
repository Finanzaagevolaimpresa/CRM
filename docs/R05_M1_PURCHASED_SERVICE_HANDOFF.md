# R05 M1 — servizio già acquistato e passaggio al tecnico

L'amministratore apre **Passaggio al tecnico** nel servizio acquistato del cliente. Il percorso riusa cliente, servizio, incarico firmato e pagamento esistenti. Non crea offerte, vendite, contratti, pagamenti o una seconda anagrafica.

## Requisiti e decisione

Servizio e anagrafiche devono essere disponibili e coerenti. Servono un incarico firmato con perimetro descritto, una rata registrata come incassata, i due documenti verificati e le loro versioni. I file devono esistere e corrispondere a dimensione e SHA-256 registrati. Lo stato «pagato» del servizio da solo non basta. Una rata può essere inferiore al totale dell'incarico: il riepilogo mostra entrambi gli importi e l'admin conferma esplicitamente che il pagamento soddisfa le condizioni di affidamento. Uno stato parziale del singolo pagamento non documenta un importo incassato e non è ammesso dal percorso.

L'admin sceglie reparto, persona, variante prevista dall'incarico, attività incluse (massimo 20), scadenza e motivazione. La variante è una denominazione amministrativa riferita al documento firmato; non finge una nuova pubblicazione del catalogo. Sono utilizzabili anche servizi storici di catalogo non più in vendita. Non è richiesto un responsabile commerciale per un acquisto già avvenuto.

Se esiste una sola pratica aperta coerente viene agganciata, conservando titolo, dati e responsabile commerciale; altrimenti si crea una pratica sullo stesso cliente e servizio. Più pratiche collegate o contesti incompatibili richiedono riconciliazione amministrativa, senza creare duplicati. Il confronto della versione del riepilogo impedisce di confermare dati cambiati nel frattempo.

Decisione, assegnazione esplicita di pratica e servizio, attività e ricevuta sono atomiche. Occorrono admin corrente, sessione autorevole e step-up effettivo. Il reparto non concede accessi a tutti i suoi membri. Il tecnico conferma personalmente la presa in carico nella propria lista di lavoro; l'admin non la sostituisce.

## Documenti, riassegnazione e storico

Il tecnico lavora nel perimetro del servizio assegnato. La scheda del passaggio permette caricamenti nello specifico servizio, senza concedere il fascicolo generale. La pratica collega direttamente i download consentiti. Documenti sensibili continuano a richiedere il permesso separato; l'admin può aver verificato una prova che il tecnico non è autorizzato a scaricare.

Le attività del passaggio appartengono al servizio, senza una seconda assegnazione personale che sopravviva al cambio del tecnico. Le successive decisioni amministrative sulla pratica aggiornano anche il referente del servizio nella stessa transazione. L'assegnazione separata dalla vecchia form del servizio viene respinta con un collegamento operativo indicato nel messaggio. Cliente/servizio/progetto del passaggio non possono essere sostituiti dalla normale modifica della pratica.

La ricevuta conserva ID, versione dell'incarico/documenti, hash delle evidenze, variante, reparto e autore del passaggio. Non contiene file, percorsi storage o copie dei dati finanziari. Usa il sanitizzatore audit esistente senza allentarlo. Le normali operazioni aggiungono eventi e non riscrivono le ricevute; non si dichiara una protezione WORM contro un amministratore del database. Se il perimetro dell'incarico cambia dopo il passaggio, la scheda segnala la divergenza.

Un doppio invio identico restituisce la ricevuta già creata senza ripetere assegnazioni o attività, anche dopo una riassegnazione successiva. Un diverso invio su un servizio già affidato è respinto: le riassegnazioni usano la scheda responsabilità.

## Qualificazione e confini

Sei prove PostgreSQL preparate: creazione senza nuova vendita, aggancio a pratica esistente, versione obsoleta/file mancante/byte alterati/pagamento non incassato, autorità/sessione/destinatario/evidenza estranea, concorrenza e rollback, revoca atomica del perimetro documentale. La fixture usa esclusivamente database effimero con guard e file sintetici.

Una prova browser reale attraversa servizio del cliente → step-up → affidamento → lista personale → presa in carico → lettura dei materiali → caricamento di un elaborato/versione → salvataggio e riapertura → revisione da altro utente → consegna simulata tramite nota interna → riassegnazione e revoca del download nella sessione già aperta. Il ramo disabled deve dimostrare assenza della mutazione. Questa prova non invia email o messaggi esterni, non costituisce qualificazione della futura funzione di invio M4 e non viene descritta come una prova produttiva.

I risultati effettivi sono quelli della CI sul candidato pubblicato. Nessuna migrazione aggiuntiva rispetto allo schema48 della PR151. Nessuna modifica a provider, dispatch, state machine, scheduler, worker, policy SSH o produzione. La ricevuta del passaggio non avvia né scavalca i controlli del percorso PracticeReadiness: tali autorizzazioni rimangono distinte.
