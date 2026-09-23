# R05 M1 — profilo, password e revoca delle sessioni

Questo incremento completa la parte profilo/password dell'accesso operatori. Si innesta sulla gestione utenti, sui ruoli e sul registro delle sessioni già presenti. Non conclude l'intera M1: restano assegnazione manuale amministrativa, reparto/referente, presa in carico distinta dalla notifica e rimozione logica con continuità delle attività. Le fasi M2–M5 restano successive secondo il mandato consolidato della Cabina R07/R05 del 23 settembre 2026.

## Comportamento

- Ogni utente attivo trova «Il mio account» e può aggiornare il proprio nome, cambiare la propria password conoscendo quella corrente oppure revocare tutte le proprie sessioni.
- L'amministratore modifica nome/email di un altro account e può reimpostarne la password o revocarne tutte le sessioni dalla scheda utente esistente. Per cambiare la propria password usa il flusso personale; il reset amministrativo su sé stesso è respinto.
- La modifica dell'email di accesso è riservata all'admin. Cambio password, reset e cambio email revocano tutte le sessioni del destinatario nella stessa transazione. Se il destinatario è l'utente corrente, viene disconnesso.
- Le password nuove richiedono almeno 12 caratteri, conferma coincidente e al massimo 72 byte UTF-8 per impedire il troncamento bcrypt. Il cambio personale respinge anche una password nuova identica alla corrente.
- I controlli sono sul server: un override `user.write`, un ID manipolato o una sessione di un'altra persona non conferiscono facoltà amministrative. Il servizio rilegge e blocca sessione e utente autorevoli prima della scrittura; una sessione revocata/scaduta o un utente sospeso/rimosso non autorizzano la modifica.
- Un login concorrente ricontrolla, sotto il blocco sull'utente, hash password ed email osservati durante l'autenticazione. Se nel frattempo sono cambiati, non emette una nuova sessione.
- Gli audit nuovi riportano evento, autore e destinatario, senza i valori del profilo, password o hash. Le risposte di errore non serializzano eccezioni né contenuti del modulo.

## Requisiti e perimetro

Le nuove operazioni richiedono il registro sessioni (`INTERNAL_SESSION_MODE=registry`); non hanno fallback ai cookie legacy non revocabili. Le operazioni amministrative richiedono inoltre il controllo privilegiato esistente in modalità enforced, con step-up valido. La PR non cambia impostazioni, chiavi, credenziali o configurazione di ambienti esistenti e non include migrazioni. Nessun invio, provider, worker, scheduler o assegnazione automatica viene attivato.

La scheda utente trasferisce al componente client solo ID, nome ed email. Il servizio conserva ruoli, override e storico; le protezioni esistenti sull'ultimo admin e sulla sospensione non vengono sostituite.

## Verifica

La CI del repository esegue lint, typecheck, unit test e build. Il workflow aggiuntivo `r05-m1-accounts.yml` qualifica lo SHA esatto della PR con PostgreSQL effimero e browser Chromium. Nessuna prova usa il database reale.

I test DB richiedono conferma esplicita sintetica, indirizzo loopback, nome database e sentinel verificato sul server prima delle scritture. Coprono password corrente errata, reset admin, override non amministrativo, sessione revocata/di terzi, concorrenza, login iniziato prima del reset/cambio email, persistenza e audit privi di credenziali. Il browser percorre creazione operatore, salvataggio/riapertura profilo, cambio password, reset admin, cambio email e revoca; ripete le azioni HTTP con sessione non autorizzata e ID alterato per verificare il diniego effettivo.

Le credenziali del browser sono generate sul runner, mascherate nei log e non raccolte in trace/video/screenshot. La qualificazione software non attesta rilascio produttivo o completamento dell'intera M1. Il backup46 resta non verificato; i tentativi storici e le prove F: sono conservati e non ripetuti.

## Impatto e ritorno al comportamento precedente

Il delta modifica accesso/profilo e aggiunge la verifica concorrente al login in modalità registry. Non modifica lo schema. Un eventuale revert software rimuove i nuovi flussi; non annulla password/email che fossero già state cambiate né riattiva sessioni revocate. Ogni distribuzione o ritorno di versione resta un'operazione distinta da questa consegna software, con verifica delle dipendenze e autorizzazione applicabile.
