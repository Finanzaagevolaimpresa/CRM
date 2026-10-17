# Email Admin: lead, cliente e conversazione interna

Incremento 2 del mandato 17 ottobre. Il canale email ordinario già qualificato
resta unico. Questa modifica non invia messaggi reali e non modifica il binding
personale, le credenziali, il cursore INBOX o la sua scadenza.

## Percorsi

- Scheda Lead → **Scrivi email**. Il contatto del lead è un suggerimento da
  selezionare; nessun destinatario o mittente è precompilato automaticamente.
- Scheda Cliente → **Scrivi email**. Non serve una pratica. I suggerimenti
  derivano dai contatti correnti del cliente ammessi all'utente.
- Pratica tecnica o da avviare → Comunicazioni, con il percorso già disponibile.
- Comunicazioni → **Nuova comunicazione interna**. L'Admin personale sceglie
  persone esistenti oppure i membri attuali dei reparti. Il riepilogo mostra
  nominativi e indirizzi. La conferma privilegiata crea solo la conversazione e
  l'accesso esplicitamente indicato; non invia un'email.

In ogni contesto: scegliere casella, Reply-To, A/CC/BCC, oggetto, testo esatto e
allegati; **Salva bozza**, **Anteprima email ordinaria**, conferma personale,
**Approva e invia**. Modifica e rifiuto richiedono una nuova decisione. Restano
distinti i percorsi manuali, l'accettazione SMTP, la consegna e la lettura.

Per un interno A/CC/BCC ammettono solo partecipanti attivi. Il reparto espande
persone reali, senza inventare indirizzi di gruppo. La selezione del destinatario
non concede accesso a lead, clienti, pratiche o documenti. Nessun altro account
Admin eredita l'autorità personale email.

## Enforcement

I nuovi contesti sono `LEAD`, `CLIENT` e `INTERNAL`. I contesti pratica storici
restano `LEGACY` in ApprovedCommunication. Nessun cliente o pratica fittizio.
La versione v1 e il suo hash restano invariati; v2 include identità del contesto,
impronta del suo stato corrente, selezioni di persone/reparti, indirizzi esterni,
impronta della directory e sorgente di ogni allegato.

Bozza, anteprima, approvazione, preparazione manuale e confine DATA rileggono
sessione, autorità personale, contesto, destinatari e allegati. Cambio di ruolo,
email, appartenenza pertinente al gruppo, partecipanti, lifecycle o allegati
invalida la precedente versione. L'utente deve creare la nuova versione.

I lettori della directory mantengono un advisory lock condiviso attraverso DATA;
le mutazioni native account e partecipanti prendono quello esclusivo prima dei
lock dell'attore. I test forzano entrambe le sequenze concorrenti con il medesimo
Admin. La verifica finale usa il clock DB, inclusa la scadenza durante I/O.
Sono conservati CAS, consumo singolo, audit atomico e blocco degli esiti incerti.

La conversazione interna è leggibile solo ai partecipanti correnti, con sessione
e permesso correnti e titolare attivo. Il ruolo Admin non consente di leggere una
conversazione altrui. La revoca blocca elenco, URL e allegati a sessione aperta.
Una successiva aggiunta esplicita può dare accesso allo storico: il riepilogo lo
espone prima della conferma. Nessun nuovo membro di reparto viene aggiunto da solo.

## Allegati

`CommunicationContextFile` usa lo storage privato locale già approvato; è distinto
dal catalogo documentale. Download POST autenticato con contesto e hash, controllo
di dimensione/bytes/riservatezza, no-store, attachment e nosniff. Nessun URL pubblico.
L'upload richiede l'Admin personale e registra metadati/audit nella stessa transazione.
Una scrittura su disco seguita da un errore DB può lasciare un file privato non
referenziato e non leggibile dal CRM: non si cancella automaticamente.

Limiti: 20 MiB per file e per messaggio; 200 MiB e 100 file per contesto, contando
anche quelli revocati. PDF, PNG/JPEG/WebP, TXT/CSV, Office/OpenDocument, XML, P7M e
ZIP nei limiti del validatore esistente. Nuove versioni sono file distinti.
Revoca blocca nuovi download e approvazioni/invii, conservando bytes e storico.
Classificazioni ORDINARY/SENSITIVE/COMPLAINT rispettano i permessi correnti; un
file sensibile non può essere declassato da una bozza ordinaria.

## Schema52 e recuperabilità

Unica migration `20261017160000_admin_email_contexts_v1`, hash normalizzati LF in
`scripts/admin-email/schema-binding.json`. Baseline 5f0d6e00b3cf, schema51.
Tre tabelle nuove, clientId nullable solo con vincolo di contesto coerente,
due relazioni nuove sulle comunicazioni e undici FK RESTRICT complessive.
Nessuna modifica dei dati storici v1, seed, provider, scheduler o concessione.
Transazione unica, lock timeout 5 s, statement timeout 30 s, guardia esatta51.
Replay/schema diverso vengono rifiutati. Nessun down-migrate.

La CI applica 51→52 con vere righe storiche sintetiche, verifica prefisso51,
inietta un errore finale e controlla rollback atomico di tabelle/colonne/vincoli.
PR140 qualifica unicamente il riavvio della stessa immagine schema52: conserva
impronte di contesti, partecipanti, file, email, tentativi, cursori, conflitti,
lifecycle, perimetri e sessioni. I dati della fixture di recupero non costituiscono
prova di autorizzazione a un invio: hanno binding e canale disabilitati.

## Verifica richiesta e limiti

- Contratti/hash v1-v2 e risoluzione destinatari: unit test locali.
- 22 scenari PostgreSQL nuovi, solo DB sintetico sentinel CI; 88 regressioni email.
- Browser nativo per lead/cliente/interno, partecipanti, upload/download, revoca,
  altro Admin, doppio clic e risposta persa. Invio reale TLS esclusivamente verso
  il server sintetico isolato già usato da PR192, in tutti e tre i nuovi contesti.
- Build/lint/typecheck e intera regressione Linux; screenshot effettivi desktop e
  mobile da ispezionare dopo CI. Nessun risultato attribuito a un HEAD diverso.

Produzione richiede PASS sul diff e piano correnti, immagine esatta del merge,
preflight fresco e autorità specifica sulla migration52. La CI verde non è il
rilascio. Workflow «Chi aggiornare», video e accessi selettivi ulteriori restano
incrementi separati.
