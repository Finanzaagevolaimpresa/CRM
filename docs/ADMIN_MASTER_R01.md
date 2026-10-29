# Admin master e operatività fluida — R01

Mandato FAI-CRM-ADMIN-MASTER-E-FLUIDITA-20261029-R01. Il mandato comprende editor,
lifecycle, account e condivisioni. Il candidato comprende conferma Admin,
recupero degli incarichi ed editor amministrativi; la matrice completa,
la qualifica e il rilascio sono ancora aperti. Nessuna completezza universale
è dichiarata da questo documento.

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
Assenza o alterazione delle prove rimane bloccante. Nessuna migrazione è inclusa
in questa prima parte.

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

Controllo Admin raccoglie 31 tipi di scheda operativa, con campi esplicitamente
selezionati. Le schede cliente, azienda, progetto, pratica e documento rimandano
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

Il cestino conserva l'identità e permette il ripristino. Le sole foglie
rimovibili (voci di spesa, collegamenti persona/azienda e scadenze) mantengono
la fotografia completa nel registro. Gli altri record ammessi usano deletedAt.
Il ripristino dei valori precedenti a una correzione prepara una nuova bozza:
non sovrascrive cronologia o approvazioni. I genitori e i limiti selettivi
sono ricontrollati anche per record figli senza clientId e per persone condivise.

Limiti ancora espliciti di questo candidato: collegamenti con dipendenze non
si spostano automaticamente; i selettori mostrano al massimo 1000 record per
tipo; gli editor nativi di account e altre condivisioni richiedono ancora la
qualifica della continuità; tutte le 250 righe e i modelli soltanto censiti
devono essere raccordati alle funzioni e alle prove. Questi limiti non sono
considerati requisiti soddisfatti.

Prove aggiunte: quattro contratti sui valori, sedici casi PostgreSQL e cinque
percorsi browser. I loro file definiscono la qualifica richiesta; solo risultati
eseguiti e legati all'HEAD possono attestare PASS. Nessuna prova sintetica
attesta il comportamento del sistema distribuito con dati reali.
