# Bozze email da Chi aggiornare

L'Admin titolare dell'autorità email personale può scegliere «Avviso CRM»,
«Bozza email» o entrambe le modalità per un aggiornamento di lead, cliente o
pratica. Una regola persistente conserva la scelta per i tipi di evento indicati.
Gli aggiornamenti dei progetti restano avvisi CRM: non esiste un contesto email
progetto e non vengono creati clienti o pratiche fittizi.

## Percorso operativo

1. Aprire «Chi aggiornare» dal record, selezionare le persone o i gruppi esistenti,
   gli eventi e la modalità. Il riepilogo mostra i destinatari attualmente ammessi.
2. Confermare l'operazione personale. Salvataggio, evento e lavoro da consegnare
   restano atomici; una regola non approva messaggi futuri.
3. In Comunicazioni aprire «Bozze da aggiornamenti». La consultazione e
   l'apertura della proposta non scrivono messaggi.
4. Preparare e salvare esplicitamente una bozza per il destinatario nominativo
   selezionato. Verificare mittente, Reply-To, oggetto, testo e allegati.
5. Usare il percorso esistente di anteprima, step-up e «Approva e invia» sulla
   versione esatta. La sola scelta della modalità non invia né approva email.

La proposta contiene il nome del record, il tipo di evento e i nomi dei campi
cambiati. Non copia valori dei campi, note private, compensi, margini o allegati.
Per questo incremento una proposta corrisponde a una persona: A è vincolato alla
persona ammessa, CC/BCC ed esterni sono vuoti. Per altri destinatari si usa una
nuova comunicazione esplicita nel contesto autorizzato.

## Integrità e autorizzazione

La provenienza immutabile vincola evento/lavoro, record e versione corrente,
perimetro, autore e destinatario con epoch, directory, regola/versione o comando
e revisione dell'autorità email. Il server rilegge i diritti e i vincoli al
salvataggio e durante il percorso di invio, incluso il controllo prima di DATA.
Gli altri Admin non ereditano il binding personale.

Revoca, scadenza, cestino, cambio proprietario, variazioni rilevanti di gruppo,
indirizzo o permessi impediscono nuove divulgazioni. Una modifica del record
richiede una nuova versione e una nuova approvazione. File, classificazione,
conflitti della ricezione e contesto delle comunicazioni sorgenti sono verificati
anche per il destinatario. Le risposte e i messaggi derivati non generano altre
proposte email, evitando catene ricorsive.

Un identificativo deterministico per lavoro e il vincolo univoco impediscono
bozze duplicate al doppio clic o dopo una risposta persa. L'audit e la versione
sono nella stessa transazione. Il blocco degli esiti di trasporto incerti rimane
quello del canale email ordinario; questa funzione non introduce ritentativi.

## Schema e rilascio

La migration `20261018060000_record_update_email_drafts_v1` porta schema54 a
schema55. Aggiunge modalità, revisione dell'autorità e provenienza; le righe
storiche restano CRM e nessun messaggio, regola o destinatario reale viene creato.
Il prefisso delle 54 migration precedenti resta invariato. SQL e schema sono
vincolati da `scripts/record-update-email/schema-binding.json`.

La CI deve verificare migration popolata, rollback atomico di un errore iniettato,
concorrenza, dinieghi, browser nativo e recupero sull'immagine candidata esatta.
Il recupero ammesso usa solo codice compatibile con schema55, senza down-migrate,
restore DB o ritorno a immagini che ignorano provenienza, lifecycle e perimetri.
Il piano produttivo e l'autorizzazione alla specifica SQL sono gate separati.

## Qualifica

Le prove locali, PostgreSQL CI, browser e recupero sono distinte. Fixture, caselle,
indirizzi, sessioni e trasporti di test sono sintetici. Nessuna prova su dati reali
o invio reale è incluso. La CI email ordinaria conserva le prove di anteprima,
rifiuto, approvazione esatta, un solo consumo e gestione dell'esito incerto.
