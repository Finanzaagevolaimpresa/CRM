# Riservatezza dell’Ufficio Tecnico e collaborazione nominativa

Requisito: FAI-CRM-RISERVATEZZA-TECNICI-E-NAVIGAZIONE-20261101-R01. Questo documento descrive il candidato in verifica; non attesta che il comportamento sia già distribuito. Produzione resta PR246/schema74 finché CI, riesame pertinente, recupero e rilascio non sono qualificati.

Il limite server prevale su ruolo, override, responsabilità, grant precedente e copia di un incarico. Consulente e Backoffice sono profili tecnici; lo sono anche account non Admin con autorizzazioni tecniche o una responsabilità tecnica canonica su cliente, progetto o pratica. L’Admin conserva il proprio account distinto. Un tecnico non assume l’identità dell’Admin o del responsabile.

## Cosa resta riservato

Pagamenti e incassi, stato/riferimenti/metodi/ricevute di pagamento, contratti firmati dal cliente di qualsiasi provenienza e note libere, comuni o interne non classificate. Un nome “tecnico” o la necessità del documento per una pratica non ne consente l’accesso. Gli importi di investimento e finanziamento mostrabili provengono dai campi espliciti del progetto; nessun importo generico viene trattato come equivalente.

Le pagine non qualificate, le azioni, i download diretti e le esportazioni restano negati ai profili tecnici. Una pagina non diventa accessibile conoscendone l’ID. Le proiezioni selettive applicano il limite corrente senza riscrivere le concessioni storiche. I messaggi con testo non classificato non sono mostrati né inoltrati a destinatari tecnici conosciuti dal CRM.

Ogni versione documentale parte da “Non classificato · negato ai tecnici”. In “Classificazione” l’Admin esamina quella versione completa e i metadati, poi registra la decisione e la motivazione. “Contenuto tecnico verificato della singola versione” richiede l’attestazione esplicita dell’assenza dei contenuti vietati. Collegamenti a contratti firmati, pagamenti o formalizzazioni e metadati riservati impediscono tale classificazione. La classificazione non crea destinatari, grant o download. Una nuova versione richiede una propria decisione; una rettifica conserva il journal. Gli originali non vengono riscritti.

## Tre percorsi operativi

1. **Antonio / Admin.** Da **Clienti**, **Progetti** o **Pratiche tecniche** apre la scheda pertinente. **Controllo Admin** offre i percorsi di correzione già rilasciati; i collegamenti si rettificano nel contesto e le prove personali restano conservate. Dagli incarichi del progetto o della pratica seleziona **Persona da incaricare**, controllando nome ed email, poi **Apri scelte per la persona**. Sceglie campi, azioni, singole versioni e scadenza. **Anteprima dell’incarico** precede **Conferma incarico tecnico**. Non occorre effettuare operazioni produttive per seguire questo esempio.
2. **Tecnico.** Da **Ufficio Tecnico**, **Pratiche tecniche** o **I miei incarichi tecnici** apre il lavoro corrente. Legge i campi concessi, incluse priorità e responsabilità nominativa quando selezionate, ed esegue le sole azioni mostrate. I file si aprono dall’incarico nella versione concessa e classificata; il download è una scelta distinta. Note e documenti riservati non diventano accessibili dal cliente, da una ricerca, da uno storico o da un vecchio URL. Un deposito appena caricato resta in revisione Admin: non è una pubblicazione.
3. **Commerciale.** Da **Le mie assegnazioni**, **Lead e offerte**, **Clienti** e **Stato e prossime azioni** apre il perimetro assegnato. Usa i percorsi commerciali e le condivisioni effettivamente autorizzate. Questo requisito non attribuisce al commerciale permessi finanziari aggiuntivi; un account che svolga anche funzione tecnica riceve il relativo limite.

## Secondo e terzo tecnico

L’Admin apre il destinatario distinto e usa **Incarico esistente da cui copiare**. **Copia nella bozza, senza concedere accesso** riporta soltanto un perimetro tecnico ammissibile. Deve seguire una nuova anteprima e conferma nominale, con nome/email, campi, versioni e scadenza. La responsabilità iniziale della copia è “supporto”: il responsabile originale e le prese in carico non cambiano. Revocare il secondo tecnico non revoca il terzo, né consente al secondo di usare l’identità del terzo. Sono vietate credenziali condivise e concessioni automatiche a tutti i clienti.

## Continuità ed esiti

La conferma privilegiata Admin dura 30 minuti; le anteprime hanno scadenze proprie. Una risposta incerta va riconciliata sullo stesso riferimento, senza nuovo salvataggio cieco. Il journal della classificazione consente la rilettura o la chiusura esplicita di un tentativo privo di effetto.

PR247 conserva il PASS sul suo esatto candidato. Il nuovo diff e PR248 richiedono il rispettivo riesame. Per SMTP, senza prova autorevole l’esito resta incerto: nessun incidente reale è stato identificato dal rilievo statico L05 e nessun invio reale serve a provarne il recupero. L02/L03 mantengono i limiti delle fonti reali disponibili; R04 mantiene fascicolo, attore e autorizzazioni originari.

## Verifica

Le prove PostgreSQL coprono classificazione persistente, replay, revoca, scadenza/registro, file, ruoli misti e collaborazione individuale. Le prove browser qualificano navigazione, login ordinario, accessi diretti, selezione e classificazione. I risultati sintetici e i riscontri reali in sola lettura vanno riportati separatamente. Nessuna suite autorizza nuove concessioni produttive o certifica tutte le 250 righe UI.
