# Coda richieste interne all'Admin — preparazione

Questo branch prosegue il mandato sui perimetri dopo la candidata PR215. Non introduce una pagina operativa, una migration, un binding, un provider o un invio. Non modifica il candidato PR215 congelato per il riesame.

`admin-request-contract.ts` definisce la richiesta iniziale di documento/integrazione: identificativo del comando, record, impronta del contesto e versioni correnti, titolo e dettaglio limitati. Non accetta destinatari, allegati, approvazioni, identità dichiarate dal modulo o comandi d'invio. Il digest distingue persona, sessione e richiesta normalizzata; non costituisce una firma di approvazione.

L'ammissione del commerciale richiede il suo lead/cliente corrente, sessione e registry validi, record operativo e perimetro corrente. L'ammissione tecnica riusa il controllo degli incarichi con la distinta azione `request_admin`. Tale azione resta non concedibile nella lista runtime della PR215: il contratto non attiva codice futuro. Due tecnici devono avere ammissioni personali distinte; una relazione con il cliente non le sostituisce.

Le dodici prove pure coprono separazione dei commerciali, due tecnici, record estraneo, ruolo Admin non sostitutivo, revoche, scadenza, cambi di contesto/versioni, richieste che tentano di contenere invii o approvazioni, limiti del testo e idempotenza. Non sono prove PostgreSQL, browser o del flusso completo.

Resta da realizzare la persistenza transazionale con storico/audit e ricevute, i resolver canonici sotto lock, la coda privata per l'Admin titolare, la risposta minimizzata al richiedente, il legame esatto richiesta/versione→bozza/versione e l'integrazione nel percorso email già qualificato. La bozza deve essere modificabile o rifiutabile e richiedere la decisione personale sull'esatta versione prima dell'invio; nessun avviso al cliente nasce dalla richiesta. I risultati di invio, consegna e lettura richiedono le rispettive ricevute e non sono stati della richiesta.

L'integrazione deve verificare i perimetri anche per apertura, ricerca, conteggi, notifiche, storico, documenti e ogni comando. Prove complete su due commerciali e due tecnici, simulazione email, revoca a pagina aperta, concorrenza e recupero di risposta persa precedono il riesame. Le nuove prove DB/browser vanno eseguite soltanto nella CI autorizzata. Eventuali SQL e operazioni produttive richiedono piano concreto, riesame e autorità specifica.
