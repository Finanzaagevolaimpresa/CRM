# M1: qualifica del rientro applicativo su schema48

Il banco `scripts/pr140/qualify-release.sh` costruisce il candidato esatto e
l'immagine di rientro `20125ce9c72ce370e6dc3ef0d66bc356607640b6`, tree
`072c423303587166e331ec1735daeb51abd5d8f6`. Quest'ultima comprende perimetri
ClientReadGrant, responsabilità/presa in carico, passaggio del servizio acquistato
e registrazione atomica della prima versione dei file caricati.
Le ricevute precedenti `CI_SCHEMA48_COMPATIBILITY_ONLY` restano valide soltanto
come prove storiche di conservazione; l'immagine d3cf non è ammessa al rientro M1.

Solo in GitHub Actions, con database sentinel e risorse attribuite, il banco:

1. Verifica le 48 migrazioni e i byte della loro storia; costruisce e identifica
   entrambe le immagini da archivio Git, con etichette commit/tree e ID Docker.
2. Esegue il percorso interno catalogo/intake e il percorso dossier già esistenti.
   Prepara un servizio già acquistato sintetico usando le funzioni applicative:
   provenienza distinta, incarico/pagamento, documenti reali di prova, decisione e
   presa in carico del tecnico. La preparazione non attesta un'azione UI privilegiata;
   quest'ultima resta coperta dalla suite browser M1 enforced/disabled.
3. Verifica sul candidato, sull'immagine di rientro e sul candidato ripreso la
   revoca del perimetro su una sessione revisore esistente, la riapertura dello
   storico M1, i byte scaricati, il diniego per utenti estranei/documenti sensibili
   e la sospensione dell'account. Ripristina le sole perturbazioni sintetiche prima
   del confronto delle impronte; confronta grant, storici, servizi, pratiche, attività,
   versioni documentali, dossier e ledger.
4. Simula un avvio candidato non valido; prova che il rientro con sessioni vive
   è rifiutato. Revoca esplicitamente le sessioni sintetiche preservandone le righe,
   avvia il rientro e poi riprende il candidato. PostgreSQL resta lo stesso, senza
   riavvio; lo storage privato resta persistente. Esporta ID e digest delle immagini.

Un eventuale `CI_SCHEMA48_M1_APPLICATION_RETURN_PASS` attesta questo preciso
rientro applicativo su database intatto. **Non attesta un ripristino di database,
un recupero dei backup C:/F:, un rollback delle migrazioni o il rilascio reale.**
Le prove storiche di backup/recupero restano separate. Il piano produttivo deve
vincolare i suoi backup, target osservato, immagini e modalità di recupero;
revoche reali e modifiche di configurazione non sono effettuate dal banco.
Il rientro dispone delle stesse funzionalità M1: non costituisce un'implementazione
alternativa capace di risolvere un difetto software condiviso con il candidato.

Stato iniziale di questa revisione: qualifica da eseguire in CI, nessuna ammissione
produttiva dedotta dalla sola pubblicazione del codice.
