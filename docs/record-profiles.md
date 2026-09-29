# Anagrafiche di lead, clienti, aziende e referenti

La patch rende compilabili i campi già presenti nel modello, senza migrazioni.

| Dove | Azione | Dati |
| --- | --- | --- |
| Lead → scheda lead | Modifica anagrafica | Nome, cognome, azienda dichiarata, persona di contatto, email, telefono, regione, provincia, comune. |
| Clienti → fascicolo → Anagrafica completa | Modifica anagrafica | Denominazione, tipo cliente, note anagrafiche. |
| Fascicolo → Azienda / Visura / ATECO | Aggiungi azienda; apri azienda → Modifica azienda | P.IVA, CF, REA, PEC, forma giuridica, sedi, territorio, ATECO, date, stato attività, dipendenti, fatturato, DURC, regime fiscale, note. |
| Azienda → Gestisci referenti | Aggiungi referente / Salva referente | Nome, cognome, email, telefono, CF, ruolo, quota di partecipazione e note. |

La conversione da lead crea il fascicolo, non una visura né una scheda azienda
già compilata. I contatti del lead e l'identità del cliente rimangono distinti;
una correzione dell'anagrafica non riapre il lead e non cambia stato commerciale,
assegnazione, contratto o pagamento. Le informazioni facoltative possono essere
completate dopo la creazione. Svuotare un campo facoltativo elimina il suo valore;
lo zero numerico è conservato.

I pulsanti rispettano i permessi esistenti (`lead.write`, `client.write`,
`company.write`) e l'assegnazione. Il salvataggio ricontrolla sul server utente,
sessione e autorizzazioni attuali, blocca la riga e applica un controllo di versione.
Un form aperto prima di una revoca o riassegnazione non conserva il diritto di
scrivere. Un perimetro di sola lettura non concede facoltà di modifica.

La scadenza effettiva della sessione viene ricontrollata dopo le attese sui lock
e prima dell'audit; una scadenza sopraggiunta annulla anche le modifiche nella
stessa transazione. Le correzioni dei contatti lead condividono con l'acquisizione
il blocco globale e la verifica dei duplicati email/telefono normalizzati,
escludendo il lead corrente. Due scritture concorrenti non possono rivendicare
lo stesso contatto. I lead acquisiti senza nome o cognome restano modificabili
senza inventare dati mancanti; i nomi dei referenti mantengono i propri vincoli.

I referenti sono legati all'azienda; gli identificativi forniti dal form non
permettono di spostare persone tra fascicoli. Una persona storica collegata a più
aziende non può essere modificata globalmente da questo form: il salvataggio si
ferma senza toccare gli altri fascicoli. La creazione usa un identificativo stabile
per evitare duplicati al doppio invio dello stesso modulo.

Ogni modifica e il suo audit sono atomici. L'audit registra attore, record,
operazione e nomi dei campi, senza copiare dati personali. Il controllo di versione
impedisce la sovrascrittura silenziosa di aggiornamenti concorrenti.

CAP e codice SDI non sono campi del modello corrente e richiedono una proposta
separata di schema. Non sono aggiunti implicitamente né registrati in campi errati.
Questa patch non cambia account reali, dati cliente, stato dei servizi o produzione.

Validazione: unità per null/zero/date/importi e overposting; PostgreSQL sintetico
per isolamento, revoca, riassegnazione, versione, referenti condivisi e rollback
atomico; percorso Chromium dal lead all'azienda e al referente, con prova di
diniego per un estraneo e per un modulo già aperto dopo revoca. Le prove
includono attese reali PostgreSQL per le scadenze di sessione e per la concorrenza
tra creazione e modifica dei contatti lead. Il percorso browser include un lead
acquisito senza nome e cognome. I controlli standard
del repository restano obbligatori. Rollback applicativo senza downgrade del
database: mantenere anagrafiche e audit già salvati. Nessuna migrazione necessaria.
