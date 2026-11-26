# Flusso operativo lead, calendari e documenti

Mandato `FAI-CRM-FLUSSO-OPERATIVO-20261126-R01`. Baseline PR262, commit `c9c0b8d830f05d9f62e975be2b760214e879ee8c`, schema77 e connettore WordPress1.4.0. La consegna precedente resta valida. Questo candidato aggiunge la migration78 senza modificare le 77 migration precedenti e senza applicarla alla produzione.

## Percorso per ruolo

La setter parte da **Oggi**. La scheda riunisce origine, esito della richiesta, storico, prossimo passo, appuntamenti, comunicazioni e documenti. Una campagna dichiarata e conservata nella ricevuta non equivale ad attribuzione verificata nella piattaforma pubblicitaria. I dati di provenienza sono leggibili solo nel perimetro corrente della scheda, anche dopo riassegnazione.

Il referente propone un commerciale abilitato. L’Admin trova le proposte in **Proposte da confermare**, apre la scheda e conferma o sceglie un altro referente dalla coda. La conferma Admin rende subito operativo l’incarico. Non occorre una seconda conferma del destinatario. Le decisioni, gli autori, le date e le eventuali conferme storiche rimangono consultabili. Un cambio di referente revoca l’accesso precedente; un ritorno allo stesso referente non riabilita un comando preparato prima della riassegnazione.

Il consulente commerciale apre la scheda assegnata e genera una bozza indipendente da un modello pubblicato. Il profilo tecnico mantiene il proprio perimetro tecnico e i riferimenti Drive del fascicolo. Le autorizzazioni sulle anagrafiche e sui documenti sono rilette anche al download, non soltanto quando viene preparata la bozza.

Guide dei sottosistemi:

- [Calendari personali e lettura notifiche](personal-calendars-and-notice-reading.md).
- [Automazioni, email, newsletter e integrazioni](workflow-automations.md).
- [Documenti, contratti e proforma](operational-documents.md).
- [Lead e setter](lead-setter.md), conservata come riferimento del percorso precedente.

## Acquisizione: evidenze e correzione

La riconciliazione read-only del 20–26 novembre ha trovato una ricevuta CRM elaborata per ogni voce WordPress presente nell’intervallo. Una ricevuta storica resta conservata anche se la corrispondente voce non è più nell’elenco WordPress osservato. L’assenza dalla lista non consente di stabilirne il motivo.

La richiesta segnalata era ricevuta e processata, ma fermata prima della coda da due corrispondenze deboli sul medesimo valore generico usato come denominazione aziendale. Le email e i telefoni completi erano differenti. La correzione estende la controprova prudenziale già presente a tutti i candidati: solo valori generici del modulo WordPress qualificato, nessun segnale forte e contatti completi distinti per ogni candidato. Basta un contatto condiviso, mancante o un segnale forte per conservare la revisione. Ricevuta, deduplicazione e decisioni storiche restano invariati. La correzione non risolve automaticamente casi reali già aperti.

L’annuncio osservato puntava alla pagina di preanalisi sul sito principale con parametri URL vuoti. Il passaggio al modulo trasporta solamente i parametri ammessi presenti nell’URL di ingresso: per questo percorso manca una prova di attribuzione alla campagna. Il confronto tra clic e visualizzazioni pagina nella piattaforma non prova da solo visite perse: la rilevazione del pixel dipende anche dal consenso marketing. Diagnosi completa e identificativi del caso sono nel dossier operativo privato, escluso dal repository.

## Qualifica e confini

La workflow CI **Operational Flow** verifica il prefisso schema77, una failure SQL prima del commit con rollback integrale, l’upgrade78, la conservazione di un lead preesistente e l’assenza di attivazioni marketing. Esegue poi prove di persistenza, isolamento per ruolo, deduplicazione, concorrenza calendario, stop dei solleciti, riconciliazione e generazione PDF. Il percorso browser usa solo account e dati sintetici. Le altre workflow del repository mantengono i propri collaudi e sono allineate al medesimo schema candidato.

Le capacità dei provider sono distinte dalle prove effettive. Il trasporto Google simulato non attesta il collegamento reale del calendario di Ivo. Una bozza email non è un invio; l’accettazione SMTP non è una consegna. Un PDF generato non attesta archiviazione Drive, firma o emissione SdI. Nessun collegamento provider, invio reale, worker, scheduler o cron è attivato da questa consegna.

Restano da autorizzare o qualificare separatamente: la decisione Admin sul caso reale in revisione; la correzione dei parametri dell’annuncio; il consenso Google per utente e la prova sul calendario di test; i testi aziendali da pubblicare; le policy e i canali delle newsletter; piano, API, sandbox e costi Tek01. Il numero WhatsApp esistente che termina in7408 è conservato.

## Rischio e ritorno alla versione precedente

I cambi condivisi riguardano autorizzazioni, assegnazioni, acquisizione e admission email. I controlli negativi e le regressioni del repository fanno parte della qualifica; una build riuscita da sola non rende il candidato pronto.

Prima di un eventuale rilascio servono review indipendente della PR sul suo commit finale e autorizzazioni distinte per merge, backup/ripristino, migration78 e deploy. Il rollback non cancella migration o registri. La procedura di compatibilità sospende i nuovi writer e il callback OAuth, preserva i lettori richiesti e verifica l’immagine precedente sul database candidato. La capacità di ripristinare un backup produttivo deve essere dimostrata nel piano operativo autorizzato; le prove sintetiche di questa PR non la sostituiscono.
