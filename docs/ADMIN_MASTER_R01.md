# Admin master e operatività fluida — R01

Mandato FAI-CRM-ADMIN-MASTER-E-FLUIDITA-20261029-R01. Il mandato comprende editor,
lifecycle, account e condivisioni. PR239 comprende conferma Admin, recupero
degli esiti, editor amministrativi e proiezioni selettive. La riconciliazione
documentale comprende 250 righe, 176 modelli e 2845 campi; non equivale al
collaudo UI di ciascun campo. Il mandato complessivo, i 18 percorsi parziali
e la qualifica finale del rilascio restano aperti.

## Conferma personale

L'Admin conferma la password per 30 minuti, entro la scadenza della sessione di
login. Gli altri ruoli mantengono cinque minuti. I vecchi token non vengono
estesi. Il token Admin è marcato e firmato; il verificatore richiede il ruolo
Admin corrente, caricato dal server. Logout, revoca della sessione, disattivazione
e rotazione della chiave mantengono i controlli correnti. La conferma non crea
autorità personali, permessi o provider. Le anteprime di incarichi e invii
conservano separatamente il proprio limite di cinque minuti.

## Incarichi: scadenza e risposta persa

Se la conferma è scaduta, la pagina conserva persona, campi, operazioni, versioni,
scadenza e motivo. Il server chiude il tentativo senza creare un incarico. La
password si riconferma nella pagina; l'operatore prepara poi una nuova anteprima
e conferma personalmente. Nessun comando viene inviato automaticamente.

Se una risposta si perde, Verifica esito legge la ricevuta già persistita. La
sola assenza non sblocca la scheda. Riconcilia e chiudi il tentativo è un comando
esplicito: acquisisce gli stessi lock su autorità, utenti, sessione e contesto
della conferma, attende le operazioni in corso e restituisce la ricevuta oppure
registra una chiusura firmata e minimizzata in AuditLog. Tutte le conferme
successive di quell'identità di comando sono rifiutate. La chiusura non modifica
un incarico e non inventa una presa in carico. Il controllo attore/sessione
impedisce la riconciliazione da un'altra sessione o per un'altra persona.

La registrazione riusa AuditLog e conserva gli eventi precedenti. La ricevuta di
chiusura usa un dominio di firma distinto e viene riletta dopo il filtro privacy.
Assenza o alterazione delle prove rimane bloccante. La migrazione 72 protegge
anche queste ricevute contro alterazione, cancellazione e TRUNCATE.

## Verifica e rilascio

Le prove pure coprono 1799/1800 secondi, altri ruoli, token precedenti, cambio
sessione e chiave, durata limitata dal login e anteprima invio scaduta. Le prove
PostgreSQL e browser devono qualificare persistenza, revoca, concorrenza,
riconciliazione e continuità delle scelte sull'HEAD candidato. Le prove isolate
non attestano l'utilizzo reale distribuito. Il mandato generale resta aperto.

Il piano di rilascio deve preservare il lettore delle nuove chiusure. Dopo una
chiusura registrata non è ammesso ripristinare automaticamente PR238, che non
conosce questo stato; occorre un candidato di recupero compatibile o un piano
esatto di ripristino qualificato. Non sono autorizzati replay, cancellazioni
dei journal, reset di cursori o invii reali da questa documentazione.

## Correzioni amministrative — candidato da qualificare

Controllo Admin raccoglie 35 voci: 33 modelli con 319 campi modificabili e due
percorsi di rettifica delle prove di consegna. Le schede cliente, azienda,
progetto, pratica e documento rimandano
all'editor; l'elenco attività offre creazione e gestione. Ogni modifica richiede
una motivazione, un riferimento univoco e la versione corrente del record.
Campi di provenienza, password, provider, firme, incassi e prese in carico non
sono modificabili attraverso un delegato generico. I flussi dedicati restano
necessari per questi atti e per i documenti tecnici privati.

La migrazione additiva 20261029190000_admin_record_revisions_v1 introduce il
registro AdminRecordRevision. Conserva prima/dopo, hash, autore e sessione;
rifiuta modifica, eliminazione e TRUNCATE delle revisioni e richiede l'audit
nella stessa transazione. Le 71 migrazioni precedenti rimangono inalterate.
L'esecuzione in produzione richiede ancora il riesame specifico, prove isolate,
backup/ripristino fresco e un piano applicativo compatibile con i journal.

Una risposta interrotta mantiene il riferimento nell'URL. Verifica esito può
recuperare la ricevuta anche dopo un nuovo login dello stesso Admin. Riprendi
lo stesso comando riusa il contenuto conservato e non duplica l'operazione.
Dopo una riapertura senza contenuto in memoria, Riconcilia e chiudi attende
l'esito concorrente oppure registra una chiusura definitiva; una richiesta
ritardata dello stesso comando non può più modificare il record. Nessun retry
automatico è abilitato. La conferma password avviene nel modulo e conserva
la bozza mentre la sessione di login rimane valida.

Il cestino conserva l'identità e permette il ripristino. Le foglie rimovibili
del catalogo, comprese voci di spesa, collegamenti persona/azienda, scadenze e
valutazioni, mantengono la fotografia completa nel registro e richiedono
assenza di dipendenze. Gli altri record ammessi usano deletedAt o il percorso
di archivio dedicato.
Il ripristino dei valori precedenti a una correzione prepara una nuova bozza:
non sovrascrive cronologia o approvazioni. I genitori e i limiti selettivi
sono ricontrollati anche per record figli senza clientId e per persone condivise.

I riferimenti hanno ricerca e paginazione da 50 risultati: un record oltre la
prima pagina rimane raggiungibile. Prima del salvataggio vengono controllati
anche i genitori conservati e non modificabili, compresi contratto, pagamento e
cliente promotore. Il cambio di un collegamento strutturale viene rifiutato
quando lascerebbe dipendenze nel contesto precedente. Non vengono trasferiti
automaticamente figli, concessioni, firme o prove. Un rifiuto conserva i valori
della bozza; è possibile correggere il collegamento e riprovare esplicitamente.

## Account, condivisioni e rettifiche

I comandi account conservano esiti e identità, proteggono l'ultimo Admin e
consentono revoca di sessioni singole o globali. Il ripristino di un account
rimosso lo mantiene inattivo. La conferma inline conserva le scelte; gli esiti
incerti si verificano prima di un nuovo comando.

Le selezioni contestuali identificano il destinatario anche tramite email.
Campi, funzioni, documenti e versioni restano puntuali. Priorità e responsabili
nominativi sono visibili nelle proiezioni solo quando concessi. Non vengono
ampliati grant per compensare una vista carente; revoca e scadenza restano
effettive. Nessun invio reale deriva dai comandi introdotti in questa fase.

Le correzioni di pagamenti già registrati richiedono prova documentale/versione,
data e dichiarazione amministrativa, conservando l'incasso originale e
allineando lo stato dei servizi collegati. Non muovono denaro. Dossier e
consegne conservano versioni, approvazioni e ricevute; è disponibile la revoca
puntuale di autorizzazioni non consumate. Le informative nascono in bozza
immutabile; i metadati degli agenti hanno versioni senza cambiare prompt,
provider, modello o attivazione.

## Copertura, prove e residui

La mappa della fase riporta 55 righe migliorate, 160 percorsi nativi con
condizioni conservate, 18 parziali, due sostituzioni con gate personale e 15
fuori mandato. Restano parziali CORE-007/015/018/029/036, FIN-019/023/031/044,
DOC-059, SET-009/041/053 e COM-005/006/013/019/023: trasferimenti di grafi,
condizioni formalizzate, revisioni catalogo, intake/readiness, documenti
acquisiti privatamente, ruoli globali, informative, video e alcune funzioni
di comunicazione/file/trasporto. Non sono requisiti dichiarati soddisfatti.

La suite Admin definisce 49 casi PostgreSQL e 15 percorsi browser, oltre ai
contratti dei valori e alla finestra privilegiata. Le regressioni R1/R2
controllano rifiuto atomico, dati e figli invariati, assenza di revisioni/audit
di successo e conservazione della bozza nel browser. La migrazione viene
qualificata separatamente su base71: prefisso e dati conservati, rollback
integrale in caso di errore, base errata e replay respinti.

Solo le prove eseguite e vincolate al commit/tree nel pacchetto candidato
attestano il risultato. Il passaggio da un candidato al successivo richiede
nuova CI e riesame pertinente. Backup fresco, esecutore e rilascio/postflight
restano da qualificare. I test sintetici non attestano il comportamento del
sistema distribuito: il controllo Chrome utente resta distinto. R04 è separato.
