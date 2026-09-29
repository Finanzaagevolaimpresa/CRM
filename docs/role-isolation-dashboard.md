# Riservatezza individuale e contatori della dashboard

La richiesta R37 separa il fascicolo anagrafico dalle attività assegnate alle singole persone. Le assegnazioni esplicite del record prevalgono sul ruolo, sul reparto, sulla provenienza e sulla condivisione del cliente. Non sono introdotte migrazioni, nuove abilitazioni di account o attivazioni di provider.

| Ambito | Prima | Con questa patch |
| --- | --- | --- |
| Admin e direzione | Supervisione globale | Conservata, con controlli sui collegamenti e sui permessi funzionali |
| Amministrazione | Dipendeva da assegnazioni/consultazioni cliente | Supervisione globale in lettura; nessun nuovo potere di modifica, approvazione AI o gestione utenti |
| Altri ruoli | Un cliente condiviso poteva estendere l'accesso ad attività altrui | L'assegnatario della singola attività/progetto/servizio/pratica determina l'accesso |
| Consultazione cliente aggiuntiva | Poteva comprendere attività e documenti del fascicolo | Apre l'anagrafica; non sostituisce le assegnazioni operative |
| Record senza assegnatario | Eredità del cliente | Segue il contesto operativo più specifico; a livello cliente è richiesta la responsabilità corrente. Un creatore diverso, quando registrato, non concede accesso |
| Offerte | Lead o cliente potevano autorizzare indipendentemente | Il lead collegato prevale; un cliente comune non aggira l'assegnazione del lead |
| Documenti | Il contesto cliente poteva bastare | Servizio/progetto assegnato oppure caricatore e responsabilità corrente; permesso sensibili sempre separato |
| Output AI/dossier generali | Consultazione del cliente sufficiente | Richiesto il creatore e il perimetro corrente, oppure supervisione. La revisione resta distinta dal produttore |
| Contatori, ricerca, report | Alcuni riepiloghi usavano filtri più larghi | Riutilizzano le decisioni sui record, inclusi i follow-up delle offerte e i servizi esportati |

L'admin continua a gestire ruolo, eccezioni ai permessi, stato account, assegnazioni e consultazioni dalle schede già esistenti in **Impostazioni → Utenti**. Lettura globale non significa approvazione indiscriminata: accettazione personale degli incarichi, permessi sui documenti sensibili e separazione tra produttore/revisore/approvatore restano vincolanti. Per gli altri ruoli un incarico operativo esplicito può dare accesso al suo contesto; il solo reparto non dà accesso ai colleghi.

Le sessioni rileggono l'account e i permessi alla richiesta successiva. Le azioni sulle attività rileggono l'assegnazione prima di salvare: una scheda già aperta non conserva un'autorizzazione revocata. Restano attivi gli audit preesistenti delle decisioni amministrative.

I contatori animano per 650 ms soltanto la copia visiva del totale reale ricevuto dal server. Il testo accessibile mantiene sempre il valore esatto; `prefers-reduced-motion` elimina l'animazione, anche quando cambia a pagina aperta. Durante il caricamento è mostrato un messaggio esplicito, senza usare zero come segnaposto.

## Verifica

Unit test di tutte le categorie di ruolo, cliente condiviso, assegnazione individuale prevalente, collegamenti incoerenti, supervisione senza privilegi di scrittura e documenti sensibili. La prova PostgreSQL sintetica attraversa più pagine di offerte e confronta liste, conteggi, dossier e report. Il collaudo Chromium copre i ruoli, URL diretti, ricerca, report, movimento ridotto e invio da un modulo aperto prima della riassegnazione. I test sulle consultazioni verificano revoca, concorrenza e audit.

## Impatto e rollback

Gli utenti operativi possono perdere visibilità di attività altrui precedentemente ereditata dal cliente. Verificare le assegnazioni prima del rilascio, senza riassegnare dati automaticamente. Amministrazione vede tutti i record delle funzioni per cui dispone di permesso. Nessun contenuto o responsabile è modificato dalla patch.

Il rollback del solo codice non richiede modifiche al database ma ripristina la precedente visibilità più ampia: richiede una decisione esplicita di rilascio. Produzione, dati reali e PR172 restano fuori da questa consegna locale.
