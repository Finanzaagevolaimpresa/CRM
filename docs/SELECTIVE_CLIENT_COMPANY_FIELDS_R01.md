# Informazioni aziendali nella selezione personale del cliente

L'autorità personale `client-sharing` può scegliere le aziende già collegate al cliente e i singoli dati da mostrare al destinatario. La selezione è vuota all'apertura: anche la denominazione va scelta esplicitamente. Sono disponibili denominazione, partita IVA, codice fiscale, REA, PEC, sedi legale e operativa, regione, provincia, comune, forma giuridica, codice e descrizione ATECO. Massimo 20 aziende per selezione; l'elenco gestionale mostra fino a 100 aziende correnti, segnalando il limite. Non sono inclusi contatti personali, note private, contratti, pagamenti o autorizzazioni di modifica/caricamento.

Il flusso esistente resta unico: destinatario, campi cliente/azienda e versioni documentali, scadenza, anteprima dei valori esatti, verifica personale e conferma. Il destinatario consulta soltanto `/shared-clients/[id]`; la selezione non abilita la scheda ordinaria dell'azienda o del cliente, né le altre relazioni. Un'azienda aggiunta in seguito non eredita la selezione. I dati di un'azienda non scelta, compreso il nome, non sono presenti nella pagina del destinatario. I limiti correnti di lettura aziendale di entrambi gli utenti sono ricontrollati; i divieti espliciti valgono anche per Admin.

## Compatibilità e invalidazione

La selezione V3 include esplicitamente `companies` e `documents`; payload, ricevute e audit registrano solo gli identificativi, snapshot firmati e conteggi necessari. I protocolli V1 e V2 mantengono gli stessi byte canonici e non ricevono campi predefiniti nuovi. Una nuova tabella separata conserva la generazione monotona dell'azienda: non viene aggiunta una colonna a `Company`, perché il contesto documentale V2 ne include già i valori nel digest.

Ogni modifica effettiva della riga aziendale, anche seguita dal ripristino del precedente valore, invalida anteprima e concessione V3. Anche eliminazione e reinserimento della medesima identità conservano una generazione crescente. Modifiche dell'azienda richiedono quindi una nuova decisione personale per la selezione interessata; nessun rinnovo automatico. La selezione intera resta indisponibile se una risorsa scelta non è più valida. La revoca rimane eseguibile anche quando l'azienda selezionata è cambiata o non esiste più.

I lock seguono utenti/sessione/cliente, aziende ordinate, generazioni e risorse documentali. Conferma, revisione, comando e audit restano atomici; un doppio comando restituisce la ricevuta già firmata. Permessi, associazione al cliente, cestino, scadenza e versioni vengono riletti durante la transazione. Gli accessi GET non creano generazioni o concessioni.

## Migration candidata, non autorizzazione produttiva

`20261021170000_selective_client_company_fields_v1` porta schema 60 a 61. Richiede il prefisso delle 60 migration e la SQL esatta della pratica documentale; crea e inizializza il registro delle generazioni, aggiunge trigger di monotonicità e amplia il vincolo dei payload e il controllo atomico esistenti. Non modifica righe `Company`, concessioni, payload V1/V2, ricevute, storico, binding personali o permessi. Non crea concessioni reali. Il registro intenzionalmente non ha una FK con cancellazione a cascata.

La transazione DDL ha `lock_timeout` di 5 secondi; un errore resta bloccante. Il replay su schema 61 è rifiutato. Hash SQL e schema sono vincolati in `scripts/selective-client-companies/schema-binding.json` e dalla qualifica cumulativa. La produzione richiede un piano specifico riesaminato e autorizzazione umana su SQL, target, impatti e recuperabilità. Nessun down-migrate o ritorno a codice che ignori V3/generazioni; nessun nuovo backup o restore DB dedotto da precedenti eccezioni.

## Qualifiche richieste sul candidato esatto

- Prove pure: catalogo chiuso, nomi non scelti, contesto, firma/compatibilità V1/V2, selezione V3, snapshot e scadenza.
- PostgreSQL sintetico in CI: conservazione delle righe di schema 60 e delle ricevute V1/V2, rollback transazionale della DDL con errore iniettato, ripetizione negata, generazioni non azzerabili, ABA, associazione, cancellazione/reinserimento, dinieghi correnti, audit atomico, doppio comando e concorrenza.
- Browser nativo sintetico: selezione per campo, anteprima e pagina destinatario desktop/mobile, diniego dei percorsi ordinari, revoca a sessione aperta, modifica durante l'anteprima, documenti selezionati insieme ai dati aziendali.
- PR140: riavvio dell'immagine compatibile con schema 61, conservazione di registro, selezioni V1/V2/V3, revoche e invalidazione ABA; nessuna attribuzione delle prove di schema 60 al nuovo candidato.

Le prove in CI non attestano uso reale o autorizzazione produttiva. La verifica visiva reale della precedente PR208 resta non eseguibile perché Antonio non ha pratiche disponibili; non viene creata una pratica di test in produzione.
