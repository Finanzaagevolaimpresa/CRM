# Catalogo di attività e checklist per incarichi personali

Il catalogo dell'Admin non si ferma più ai primi 50 elementi di ogni tipo. Ricerca
letterale e filtro per tipo si applicano dopo la lettura e l'ammissione correnti di
ciascun elemento. Ogni pagina contiene al massimo 20 risultati ammessi; «Altri
elementi» richiede un ventunesimo risultato ammesso. Titoli finanziari, collegamenti
documentali non ammessi e altri progetti dello stesso cliente restano esclusi.

L'Admin mantiene le scelte esplicite fra pagine e ricerche. Gli elementi selezionati
fuori pagina restano visibili e rimovibili, con i campi scelti e la generazione
originaria. Una rilettura del catalogo non rinnova silenziosamente la selezione.
L'anteprima e la conferma esistenti rileggono ogni elemento sotto lock; se contenuto,
contesto, versione o permessi sono cambiati, occorre rimuovere e scegliere di nuovo
l'elemento. Un risultato del catalogo non è un incarico o una concessione.

La ricerca usa una server action di sola lettura con origine corrente, sessione
autorevole, autorità personale e destinatario correnti. Nessun nuovo step-up è
richiesto per leggere; la conferma dell'incarico mantiene quello esistente. La
risposta contiene solo i metadati del catalogo. Non sono esposti descrizioni, note,
documenti, altri proprietari o contenuti finanziari. Errori/limiti non restituiscono
cataloghi parziali come se fossero completi. La revoca rimane disponibile anche
quando il solo catalogo degli elementi non è disponibile.

Se la transazione di caricamento fallisce (anche per timeout o errore SQL), la
pagina avvia una nuova lettura senza interrogare i cataloghi. Rilegge autorità
personale, sessione, contesto e storico firmato: nessun dato della transazione
fallita viene riutilizzato. Mostra l'indisponibilità e soltanto storico, recupero
degli esiti e revoca; nasconde il modulo per nuovi incarichi. Un diniego nelle
guardie correnti continua a impedire l'apertura. La revoca mantiene anteprima,
step-up, versione esatta e audit atomico già esistenti.

Il limite difensivo è 6000 candidati complessivi del cliente, indipendente da
ricerca, tipo e pagina. Le letture mantengono le guardie temporali e transazionali
esistenti; un fallimento impedisce la nuova scelta. Non viene aggiunto un conteggio
globale o un filtro SQL che trasformi i caratteri dell'utente in pattern.

Nessuna migration, dipendenza, provider, scheduler o mutazione di dati esistenti è
introdotta. I nuovi comandi di creazione/stato e la navigazione del catalogo
documentale restano incrementi distinti. Gli elementi futuri e le versioni future
non sono inclusi automaticamente.

## Verifica del nuovo candidato

- Contratti puri: limiti, ricerche letterali e Unicode, conservazione di scelte fuori
  pagina, generazioni e campi esatti, nessuna eredità da un'azione disabilitata.
- PostgreSQL isolato: oltre 50 elementi e quattro pagine; esclusioni prima della
  paginazione; errore indipendente dalla query oltre il limite; nessuna scrittura
  della ricerca; due tecnici/due commerciali e Admin privo del binding; scelta
  obsoleta respinta e nuova scelta esplicita utilizzabile.
- Recupero da errore: timeout P2028 simulato e transazione PostgreSQL realmente
  abortita; nuova lettura senza cataloghi, zero scritture, revoca personale
  utilizzabile e diniego se la sessione è revocata fra le due letture.
- Browser nativo: ricerca/pagine, due scelte conservate e presenti nel riepilogo,
  incarico confermato e lavoro effettivo sul solo elemento selezionato; altri
  tecnici, commerciali e URL negati; cambio concorrente e anteprima obsoleta;
  catture desktop/mobile. Le tre prove esistenti restano presenti.
- Browser con lock reale su un'attività oltre il timeout della transazione:
  indisponibilità esplicita, storico e revoca utilizzabili, blocco della modifica
  già aperta dal tecnico e successivo diniego per URL. Nessun timeout o controllo
  produttivo viene allentato per superare la prova.

Questa documentazione descrive il candidato. Il completamento richiede gli esiti
della CI sull'HEAD pubblicato, il riesame pertinente e il piano di rilascio. Nessuna
prova pregressa è attribuita a questo nuovo HEAD e nessun uso reale è simulato.
