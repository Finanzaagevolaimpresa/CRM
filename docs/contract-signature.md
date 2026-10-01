# Registrazione di una firma già acquisita

Il dettaglio del contratto permette di registrare la firma di un documento già sottoscritto fuori dal CRM. Prima erano disponibili creazione e consultazione, ma nessun comando aggiornava `status`, `signedAt` e `signedDocumentId`; M5 richiede proprio un contratto firmato collegato al documento.

## Percorso operativo

1. Registrare il contratto con numero, servizio e importi effettivi, collegandolo al cliente corretto.
2. Caricare il documento firmato nel fascicolo, sezione **Contratti**, sullo stesso progetto del contratto (oppure senza progetto per entrambi). Il documento deve stare nel fascicolo generale, senza collegamento a un servizio.
3. Aprire il contratto, selezionare il documento/versione disponibile, indicare la data effettiva di firma e confermare l'attestazione.
4. Premere **Registra firma già acquisita**. Il dettaglio mostra lo stato firmato e la data.

Questa registrazione non sottoscrive un accordo, non invia documenti, non accetta offerte, non registra incassi e non avvia pratiche. Non inventare numero, importi o data per completare una prova. Un pagamento atteso resta atteso; M5 conserva i propri controlli separati.

## Accesso ed evidenze

Sono richiesti `contract.write`, `document.download` e `document.sensitive.read`, con i consueti perimetri di modifica del cliente/progetto. Il limite non delegabile riserva contratti e pagamenti ad Admin, Amministrazione e Direzione: assegnazioni e override non consentono agli altri ruoli di registrare firme. La sola appartenenza a un ruolo autorizzato non concede permessi di scrittura mancanti. L'amministrazione conserva la competenza globale sui contratti già prevista dai suoi permessi; una concessione di sola lettura non consente registrazioni. Sessione, ruolo e permessi vengono riletti e bloccati nella transazione. La scadenza della sessione viene ricontrollata anche dopo eventuali attese sui lock e prima del commit.

Il contratto deve essere ancora non firmato e avere la stessa versione mostrata all'operatore. Documento e ultima versione devono essere del cliente/progetto esatto, nella sezione contratti, attivi, coerenti per percorso e checksum. La data usa il calendario Europe/Rome e non può essere futura. Il documento resta un'evidenza attestata dall'operatore: il software non verifica una firma digitale o l'autenticità della sottoscrizione.

Aggiornamento e audit `contract_signature_recorded` sono atomici. L'audit conserva data, identificativi del documento/versione e checksum; non conserva contenuto o percorsi storage. Un doppio invio non produce una seconda registrazione. Contratti già firmati, annullati o archiviati non vengono riaperti; eventuali rettifiche richiedono un percorso distinto.

## Verifica e rilascio

La CI `Contract signature qualification` verifica schema input, permessi e perimetri, concorrenza, scadenza sessione sotto lock, rollback su errore audit, documento sostituito/inaccessibile e pagamento invariato su PostgreSQL effimero protetto da sentinella. Il browser carica un PDF sintetico, registra la firma e controlla persistenza, singolo audit, pagamento atteso e assenza di avvio M5. La CI ordinaria esegue i controlli di regressione del repository.

Nessuna migrazione, variazione di configurazione, provider o worker. Merge, rilascio e registrazione di dati reali restano operazioni distinte con le autorizzazioni applicabili. Il rollback del codice rimuove il modulo; non annulla firme o audit già registrati e non modifica i pagamenti.
