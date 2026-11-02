# Aprire il cliente collegato e verificare un incasso

Da **Lead**, aprire la scheda. Se il lead è già collegato, il riquadro **Cliente già collegato** compare all’inizio della pagina. **Apri fascicolo cliente** apre il cliente esistente se è leggibile nel perimetro corrente. Un collegamento esistente impedisce di proporre una seconda conversione, anche quando il fascicolo è indisponibile.

Se il collegamento è stato creato mentre il modulo di conversione era aperto, il CRM ricontrolla i permessi. Chi può convertire un lead ma non leggere il cliente torna al lead. Il comando non restituisce i dati del fascicolo.

Se nel frattempo l’account ha assunto una funzione tecnica, il controllo sul suo ruolo, sui permessi e sugli incarichi correnti blocca la conversione prima della creazione del cliente.

Da **Pagamenti**, scegliere **Conferma pagamento · Incassato** accanto alla rata esistente. **Crea rata da incassare** crea invece una nuova rata e non dichiara un accredito.

Nell'editor amministrativo della rata, il selettore **Stato** propone **Incassato · Conferma pagamento** quando non esiste ancora un incasso registrato. Questa scelta mostra **Apri conferma pagamento** e apre il percorso in una nuova scheda, mantenendo nella prima le modifiche non salvate. La conferma usa i dati già salvati. La scelta non invia un aggiornamento generico di stato e non si completa con **Salva operazione**.

Se il server trova un impedimento, il modulo mostra il primo requisito che manca e un link alla scheda pertinente. Ad esempio, un contratto in stato **da preparare** rimanda al contratto collegato. **Registra il contratto firmato** richiede la versione pertinente e il giorno di firma verificato. Una dichiarazione della firma e la registrazione della fonte firmata sono operazioni distinte. Per una rata scaduta restano applicabili le condizioni di stato del percorso: l'opzione nell'editor non le modifica.

Per una rata ammissibile servono la data e l’ora effettive dell’accredito, la versione verificata della relativa prova nel fascicolo e la conferma personale dell’Admin. Il contratto firmato, le coordinate per il bonifico e una nota commerciale hanno funzioni diverse dalla prova dell’accredito. La registrazione nel CRM conserva la dichiarazione e la versione scelta.

La sezione **Servizi acquistati** è proposta solo se contiene il servizio collegato e l’utente può leggerlo. Un collegamento storico a un servizio cancellato continua a bloccare la rata. Il modulo rimanda ai pagamenti visibili del fascicolo.

Se la risposta a una conferma manca, usare **Verifica esito** per lo stesso comando. Questo controllo resta disponibile per una richiesta in sospeso anche quando la rata risulta già incassata. Ogni conferma ricontrolla sul server le condizioni correnti.

Dopo la conferma, **Incasso registrato** indica la registrazione e **Apri pagamenti e verifica lo stato** rilegge l'elenco. Una rata confermata mostra **incassato** e **Apri incasso e verifiche**. Una ricevuta riletta documenta l'incasso originario: eventuali storni o rimborsi successivi restano visibili nello stato corrente e nello storico.

Il limite tecnico si applica alle pagine, alle azioni, ai file e alle informazioni sul motivo del blocco. La navigazione dal lead rispetta i permessi sul fascicolo. La registrazione dell’incasso non crea un servizio acquistato.
