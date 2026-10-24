# Rimozione account: interfaccia pronta prima della conferma

Il merge PR218 `6f351864d122a000aff4e6ca4078c11a3327f4d1` ha ottenuto PASS nel workflow dell'immagine (archivio acquisito, verifica completa non eseguita prima del blocco) ma ha fallito una regressione browser M1 (`40082223685`, job `120837942546`). Il modulo poteva essere premuto prima dell'idratazione: il server ha respinto la richiesta con origine `null` e la prova è rimasta in attesa dell'azione client. La produzione è rimasta a PR217/schema65, senza applicare SQL66.

La correzione mantiene disabilitati conferma e pulsante nell'HTML iniziale. Si abilitano soltanto quando React ha completato l'idratazione; i dinieghi esistenti per account proprio, configurazione e operazione pendente restano attivi. Il pattern `useSyncExternalStore` riusa quello già presente nei moduli amministrativi. Origine, step-up, controllo della sessione, conservazione dello storico, revoche e audit non sono modificati.

La nuova prova nativa apre la pagina autenticata con JavaScript disabilitato e verifica i controlli inattivi senza mutazioni; dopo l'idratazione verifica anche il diniego di auto-rimozione. La prova esistente conserva l'intero percorso step-up/rimozione/revoca immediata, replay e assegnazioni storiche. Nessuna asserzione è rimossa, nessun timeout aumentato e nessun retry aggiunto. Screenshot del solo modulo sintetico sono acquisiti a desktop e 390px.

Non viene aggiunta SQL. Il recupero del rilascio richiede un nuovo candidato esatto, CI completa, riesame pertinente e autorità sul nuovo rilascio; la SQL66 già autorizzata resta byte per byte invariata. L'immagine PR218 non può essere attribuita a questa correzione. Nessuna operazione su account o dati reali è compresa nelle prove.

I quattro workflow filtrati di permessi di modifica lead, incarichi tecnici, richieste Admin e attività tecniche includono ora il modulo di rimozione e i suoi test browser. La rimozione e la revoca della sessione incidono su questi percorsi: le suite vengono rieseguite sull’esatto candidato correttivo, senza ereditare risultati del precedente HEAD. Nessuna asserzione o requisito CI viene ridotto.
