# Richieste interne all’Admin e bozze email

Commerciali e tecnici possono proporre una richiesta di documento o integrazione dal record ammesso. La coda conserva richiesta, chiarimenti e decisioni; nessuna richiesta manda un avviso al cliente.

## Percorso operativo

- Il commerciale parte dal proprio lead o cliente; un tecnico parte dall’incarico personale sul preciso progetto/pratica, con operazione `request_admin` esplicitamente assegnata.
- L’autore può integrare o ritirare una richiesta aperta. Non vede richieste di altri autori, destinatari email, contenuti della bozza o note amministrative.
- Il titolare personale email già registrato può chiedere chiarimenti, rifiutare o aprire il compositore. Il solo ruolo Admin di un altro account non basta.
- Il compositore mostra separatamente le indicazioni interne. Mittente, destinatari, testo e allegati richiedono scelte esplicite; non vengono copiati dal testo della richiesta.
- Il primo salvataggio crea una sola bozza, versione 1, nello stesso commit transazionale dell’evento e dell’audit della richiesta. L’email resta da approvare tramite il percorso personale esistente: anteprima, step-up, versione esatta, consumo singolo, gestione dell’esito incerto.

Una richiesta da progetto conserva il progetto di origine e usa il contesto email del suo cliente reale. Una pratica usa il proprio contesto tecnico. Non vengono creati clienti o pratiche fittizi. Non si trasferiscono concessioni né il referente commerciale.

## Confini e concorrenza

Sessione del chiamante, attore corrente, permessi, titolarità, lifecycle, revisioni e scadenze vengono riletti sul server. La revisione Admin controlla l’identità corrente dell’autore senza impersonarne la vecchia sessione. La chiusura della vecchia sessione non cancella la richiesta; una revoca del perimetro ne blocca consultazione e utilizzo.

Gli incarichi tecnici sono verificati contro registro, decisione e prova conservata. L’operazione su un incarico non si propaga a un altro target. Scelta documentale e permesso di download restano separati e non cambiano con la richiesta.

Le transazioni sono serializzabili. Ogni comando ha UUID e digest legato a utente, sessione e input esatto; ripetere il medesimo comando restituisce la ricevuta conservata. Risposte perse si verificano senza rieseguire il comando. L’audit non contiene il testo della richiesta: registra revisione, operazione e hash. Eventi e legame alla bozza sono immutabili.

Tutte le letture sono prive di effetti persistenti. Una bozza collegata ricontrolla l’origine anche nelle vie email già esistenti, comprese modifica, anteprima, approvazione e invio. Una vecchia approvazione non sopravvive a una nuova versione.

## SQL e recuperabilità

Migration `20261023160000_admin_request_queue_v1`: schema 64→65, tre tabelle vuote `AdminRequest`, `AdminRequestEvent`, `AdminRequestDraft`. Vincoli, trigger di storico immutabile e vincoli differiti collegano stato/evento/audit/bozza atomicamente. Nessun nuovo binding, destinatario, concessione, provider, cron o invio.

Il manifest `scripts/admin-requests/schema-binding.json` fissa base, SQL e datamodel. I 64 SQL precedenti rimangono identici. La qualifica CI prova base errata, errore a fine transazione, dati preesistenti invariati, replay e drift. I test DB e browser usano esclusivamente database con sentinel sintetico.

La prova PR140 riavvia la stessa immagine e conserva richieste, bozze, storico, perimetri, tentativi incerti e cursori. Non qualifica down-migration, rollback a codice precedente, nuovo backup o restore del database.

## Qualifica richiesta

I contratti puri coprono due commerciali, due tecnici, autorità personale, contenuti non interpretabili come comandi, epoch e revisioni. PostgreSQL deve provare esiti positivi e dinieghi, replay concorrente, audit atomico e revoca sulle bozze. Il browser nativo deve provare richiesta, chiarimento, composizione vuota, bozza senza invio, doppio clic e risposta persa, anche su mobile.

Il completamento tecnico richiede CI sull’HEAD finale e riesame dello stesso revisore. Il rilascio richiede piano concreto, autorità pertinente per SQL65 e rilascio, immagine esatta del merge, preflight, cutover limitato e postflight. Questo documento non attesta tali gate né uso reale; non usare dati reali come fixture.
