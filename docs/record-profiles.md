# Anagrafiche di lead, clienti, aziende e referenti

Il percorso anagrafico originale rende compilabili i campi canonici. Il seguito
«Aggiornamento condiviso» aggiunge campi facoltativi con lo schema 76; il suo
rilascio deve essere qualificato separatamente.

| Dove | Azione | Dati |
| --- | --- | --- |
| Lead → scheda lead | Modifica anagrafica | Nome, cognome, azienda dichiarata, persona di contatto, email, telefono, regione, provincia, comune. |
| Clienti → fascicolo → Anagrafica completa | Modifica anagrafica | Denominazione, tipo cliente, note anagrafiche. |
| Fascicolo → Azienda / Visura / ATECO | Aggiungi azienda; apri azienda → Modifica azienda | P.IVA, CF, REA, PEC, SDI, forma giuridica, sedi legale e operativa strutturate (via/piazza, civico, CAP, città, provincia), indirizzi storici, territorio, ATECO, date, stato attività, dipendenti, fatturato, DURC, regime fiscale, note. |
| Azienda → Gestisci referenti | Aggiungi referente / Salva referente | Nome, cognome, email, telefono, CF personale, ruolo, indicazioni esplicite di amministratore e referente operativo, quota di partecipazione e note. |

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
escludendo il lead corrente. Il controllo riguarda i contatti canonici cambiati:
un duplicato storico invariato, anche con sola variazione di maiuscole o formato,
non impedisce di correggere territorio o altri campi, né l'altro contatto.
Due scritture concorrenti non possono rivendicare
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

Lo schema 76 aggiunge SDI e indirizzi strutturati a `Company`, e due qualifiche
indipendenti a `CompanyPerson`. Non interpreta o riscrive gli indirizzi storici;
non presume che amministratore e referente siano la stessa persona. I valori
nuovi sono nulli e le qualifiche false finché un operatore autorizzato li compila.
Il codice SDI, quando presente, ha sette caratteri alfanumerici normalizzati in
maiuscolo. Un modulo precedente che omette i nuovi campi non ne cancella i valori.
Nessun campo nuovo è obbligatorio per la conversione del Lead o per un aggiornamento
operativo. Le note precedenti non entrano nella proiezione tecnica condivisa.

Validazione: unità per null/zero/date/importi e overposting; PostgreSQL sintetico
per isolamento, revoca, riassegnazione, versione, referenti condivisi e rollback
atomico; percorso Chromium dal lead all'azienda e al referente, con prova di
diniego per un estraneo e per un modulo già aperto dopo revoca. Le prove
includono attese reali PostgreSQL per le scadenze di sessione e per la concorrenza
tra creazione e modifica dei contatti lead. Il percorso browser include un lead
acquisito senza nome e cognome. I controlli standard
del repository restano obbligatori. Rollback applicativo senza downgrade del
database: mantenere anagrafiche e audit già salvati. Per l'estensione schema 76
usare la qualifica e il recupero compatibile descritti in
[Aggiornamento condiviso](SHARED_OPERATIONAL_UPDATES_R01.md).
