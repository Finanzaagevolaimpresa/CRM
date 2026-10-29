# Admin master e operatività fluida — R01

Mandato FAI-CRM-ADMIN-MASTER-E-FLUIDITA-20261029-R01. Il mandato comprende editor,
lifecycle, account e condivisioni. Questa prima parte implementa la conferma
Admin e il recupero degli incarichi: non dichiara completato il controllo Admin.

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
