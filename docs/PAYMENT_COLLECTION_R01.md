# Conferma dell’incasso — contratto di lavoro

Stato: candidato implementato per qualificazione e riesame, non attivato in produzione. La base è il merge PR203 `0709ded32180ead054ae4573aa1890285702cc57`; nessuna modifica Prisma o migration. Schema 58 conservato.

## Problema osservato

La pagina Pagamenti inserisce un pagamento nello stato `da_incassare`. Non espone la conferma della data di incasso né il collegamento a `accountingDocumentId`. La registrazione del servizio consente correttamente di lasciare il pagamento da collegare; il passaggio al tecnico richiede un incasso e una prova coerenti già presenti.

## Risultato richiesto

L’Admin con autorizzazioni ordinarie correnti apre un pagamento del cliente, sceglie una data effettiva non futura e la prova documentale esistente, controlla il riepilogo e conferma personalmente l’incasso. Non vengono creati contratti, pagamenti duplicati, documenti, servizi o assegnazioni per aggirare i requisiti. L’importo resta quello della rata esistente; eventuali rettifiche contabili sono un flusso distinto.

La nuova azione usa i campi Payment esistenti e i documenti/versioni privati. L’esito positivo distingue la dichiarazione personale sul fatto economico dalla verifica tecnica e contestuale del file: nessuna verifica bancaria automatica. Richiede la conferma amministrativa personale corrente (step-up), senza nuovi binding o credenziali.

## Percorso nativo

Admin → Pagamenti → riga della rata esistente → Conferma incasso. Data/ora effettive e documento verificato sono scelte obbligatorie, senza valori impliciti. L’anteprima mostra cliente, incarico, importo immutato, data, documento/versione e progetto. La conferma esplicita registra l’intera rata: non consente importi parziali o rettifiche. L’importo della rata può rappresentare un acconto del contratto.

Il successivo collegamento al servizio e il passaggio al tecnico restano azioni esplicite già disponibili. Incasso registrato non crea un servizio, una pratica, un’assegnazione, un avviso o un invio. Una rata già collegata a un servizio non viene modificata da questo nuovo flusso.

## Confini di implementazione

- Sessione e attore attuali, permessi `payment.write`, `payment.read`, `contract.read`, `client.read` e lettura del documento; Admin destinatario di perimetri selettivi resta escluso dalle mutazioni non consentite.
- Stesso cliente e incarico, lifecycle attivo, importo positivo entro il contratto, documento contabile distinto dall’incarico firmato, ultima versione valida con checksum e file verificabili. Nessun dato privato o contenuto del file in audit.
- Riepilogo vincolato a versione e contesto correnti. Rilettura SERIALIZABLE sotto lock di chiave, directory, sessione/attore, cliente, contratto, pagamento e risorse collegate. Conflitti serializzabili interrompono il comando senza retry automatico. File privato letto con limite 50 MB, dimensione/checksum confrontati all’anteprima e alla conferma.
- Aggiornamento pagamento e ricevuta minimizzata nella stessa transazione; il cliente resta invariato. Anche la riconciliazione blocca la stessa riga Payment: una snapshot SERIALIZABLE precedente alla modifica deve fallire per conflitto anziché dichiarare falsamente assente la ricevuta. Comando idempotente con confronto esatto; nessun retry cieco della mutazione.
- Dopo risposta persa o reload, superficie di riconciliazione raggiungibile anche se l’incasso risulta già registrato. Nuove scritture restano chiuse; permessi e sessione correnti sono ricontrollati.
- Se il pagamento è già consumato, in conflitto o incoerente, mostrare un esito comprensibile e fermarsi. Nessuna cancellazione o sovrascrittura dello storico per sbloccare l’affidamento.

## Verifiche necessarie

Workflow `payment-collection.yml`: 25 prove PostgreSQL e 7 browser nativi, tutti sintetici con sentinella DB verificata, zero skip attesi. Coprono concorrenza, rollback di pagamento/audit, minimizzazione N04 effettiva, diniego/revoca, scadenza, perimetri selettivi anche indiretti, file/ultima versione, anteprima obsoleta, doppio clic, risposta persa/reload/riconciliazione e indisponibilità della memoria della sessione. Il browser mobile completa registrazione servizio senza pagamento → incasso → collegamento → passaggio tecnico. Nessun nuovo invio o operazione su clienti reali. Gli esiti devono essere acquisiti sul preciso HEAD; la presenza dei test non attesta il loro PASS.

Prima del rilascio: candidato esatto e CI verde, stesso revisore, piano app/schema compatibili e verifica dell’autorità pertinente. Non dichiarare assenza di migration fino alla verifica del diff finale. Nessun nuovo provider, backup, concessione o binding implicito.
