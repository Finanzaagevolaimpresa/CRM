# R05 M1 — continuità dopo sospensione e rimozione logica

Incremento software successivo a PR148. M1 resta parziale; nessuna disponibilità
produttiva, attivazione o operazione reale è attestata da questo documento.

## Comportamento

L'admin può rimuovere logicamente un altro account con sessione registry valida
e step-up obbligatorio. `active=false` e `deletedAt` impediscono nuovi accessi;
le sessioni esistenti sono revocate nella stessa transazione dell'audit.
La rimozione di sé stesso o dell'ultimo admin attivo è vietata. Una seconda
richiesta non cancella altri dati né produce un secondo evento di rimozione.
Non esiste un comando di cancellazione definitiva o ripristino dell'account rimosso.

Identità, assegnazioni, attività e decisioni storiche restano registrate con gli
stessi identificativi. Gli account rimossi sono consultabili dall'admin tramite
la vista dedicata. Il comando di riattivazione degli account sospesi non ripristina
un account rimosso e non rende nuovamente valide sessioni revocate.

`/settings/assignment-exceptions` elenca i riferimenti non archiviati ancora
assegnati a utenti sospesi o rimossi: lead, clienti, progetti, attività, servizi,
pratiche tecniche. Conserva separati i responsabili commerciali e tecnici già
presenti. È una vista derivata dagli assegnatari canonici, senza una seconda
tabella di proprietà. Include anche lavori completati, esplicitamente etichettati
come riferimenti conservati da verificare; non li dichiara nuovamente da eseguire.
Contatori e pagine da 50 elementi permettono di percorrere l'intera coda.
Un'esplicita riassegnazione a un operatore attivo rimuove il riferimento dalla
coda. La sospensione non inventa un sostituto e non sovrascrive una decisione.

Ogni riga riporta ora lo stato effettivo; gli stati conclusivi sono identificati
come riferimenti storici. Le attività hanno una destinazione amministrativa
dedicata al loro ID, anche senza cliente o oltre le prime 50 attività del
fascicolo. Il comando richiede admin corrente, permesso utenti, registry e
step-up enforced; ricontrolla il destinatario attivo sotto lock e confronta
la revisione dell'attività. Modifica soltanto il responsabile e registra l'audit
nella stessa transazione, senza riaprire un lavoro completato o annullato.

Lettura della coda e rimozione ricontrollano la sessione e il ruolo effettivo.
Le mutazioni utenti preesistenti ricevono ora la sessione completa dal server;
in modalità registry non basta un vecchio userId. Attore e destinatario restano
bloccati per la transazione, coordinandosi con i lock delle assegnazioni.
Il contratto storico legacy delle funzioni preesistenti resta separato; la nuova
rimozione e la nuova coda richiedono registry. Nessuna modalità viene attivata.

## Verifica e limiti

Le prove PostgreSQL coprono tutti e sei i tipi di riferimenti, revoca, dinieghi
con sessioni scambiate/revocate e override, concorrenza tra due admin, rollback
su errore audit, coda oltre 50 righe, riassegnazione e riattivazione.
La concorrenza sui lock PostgreSQL espone anche SQLSTATE 40001/40P01 dentro
l'errore raw-query Prisma: viene ricondotta al conflitto controllato già usato
per P2034, senza ritentare automaticamente la mutazione. Gli altri errori
(vincoli, permessi e guasti generici) conservano la propria classificazione.
Il browser usa i veri endpoint: tentativo senza step-up, prova con modalità
privilegiata disabled, richiesta HTTP non admin, rimozione, accesso già aperto,
riapertura dell'archivio, coda e successiva riassegnazione cliente. Nessun invio
esterno o dato reale è necessario per queste prove.

Le regressioni del riesame aggiungono una coda mista (aperta/completata/annullata),
una riassegnazione HTTP di attività senza cliente e una oltre 52 record più
recenti nel fascicolo. Verificano i dinieghi senza step-up, disabled e non-admin,
replay obsoleto e conservazione dello stato; le prove PostgreSQL includono
sessione revocata, destinatario inattivo e rollback in caso di errore audit.

Il PASS va riferito al candidato e alla CI effettivamente conclusa, non alla
presenza dei test nel sorgente. I limiti del runner locale restano dichiarati.

Questa coda copre sospensione/rimozione di account esistenti, non una bonifica
retroattiva di eventuali riferimenti a utenti cancellati fisicamente in passato.
Origine commerciale distinta, reparti, accettazione individuale, isolamento
completo delle superfici legacy e servizio acquistato direttamente al tecnico
restano negli incrementi M1 successivi, prima di M2–M5.

## Lifecycle

Nessuna migrazione: schema e 47 migrazioni storiche sono invariati. Il revert
software non riattiva account rimossi, non annulla revoche né ricostruisce vecchie
assegnazioni. Un ritorno alla versione precedente nasconde la nuova coda e riduce
i controlli sulle sessioni delle mutazioni utenti; va considerato nel piano di
eventuale rollback autorizzato.

deploy_required=YES; migration_required=NO per questo delta;
production_change_required=YES per una futura disponibilità;
runtime_revalidation_required=YES. La consegna non aggiunge autorizzazioni
operative e conserva quelle pregresse pertinenti entro ambito, target e gate.
PR145/R06, ricevute e due tentativi backup consumati sono conservati. F: non è
riprovato. Nessun deploy, backup reale, migrazione produttiva o attivazione.
