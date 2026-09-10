# VNX03 / N14 — qualifica browser commerciale R01

## Scarto coperto

Questo addendum estende, senza sostituirla, la qualifica VNX03 esistente. Lo scenario storico
continua a eseguire WPForms → connettore → HTTPS verificato → N12/N11 → VNX01/VNX05 → N13 con
`COMMERCIAL_LEAD_INBOX_MODE=disabled` e sessione `legacy`. La fase nuova parte soltanto dopo quel
collaudo e abilita N14 in un processo CRM sintetico separato con session registry autorevole.

## Scenario obbligatorio

La fase N14 usa lo stesso WordPress/WPForms, connettore, gateway TLS, database effimero e consumer
reali già bloccati dal banco. Crea prima tre utenti inventati e una policy SLA 24x7 UTC valida,
poi esegue un nuovo submit browser. Il consumer proietta il Lead N13 e lo iscrive nell'inbox N14.
Playwright verifica login reale e visibilità dell'item non assegnato. Distingue i campi HTML
`$ACTION_ID_` dai riferimenti bound `$ACTION_REF_`, ricava dai due form reali l'identità non-bound
attesa e la confronta con l'header `next-action` emesso dal client Next con JavaScript attivo.
Trattiene esclusivamente i POST diretti all'esatto path/query dell'inbox con tale header. Dopo aver
osservato entrambi gli invii, attende il completamento delle
due risposte e richiede un HTTP 200 e un HTTP 500; il 500 prova soltanto l'esito HTTP. Una sonda
supplementare invoca lo stesso servizio N14 con `INTERNAL_SESSION_MODE=registry` esplicito e con la
sessione registry emessa dal login; il prerequisito è asserito prima dell'operazione e la sonda comprova il
conflitto del comando stale, una sola ownership/activity e stato invariato. Seguono reload,
registrazione della prima risposta e ciclo SLA `MET`. Anche per il primo contatto il test attende la
risposta HTTP 200 dell'esatta server action e la scomparsa del comando dalla UI prima del reload e
della verifica persistente.

Un secondo commerciale non vede né apre il Lead assegnato. Con la sua sessione autentica il browser
reinvia inoltre il comando ricavato dal form applicativo reale: la risposta non-success e gli assert
DB provano owner, versione, SLA, activity e audit invariati. Una sonda supplementare sulla medesima
sessione comprova il diniego N14 specifico senza dedurlo da un generico HTTP 500. Anonimo e utente
inattivo non accedono.

Per ogni commerciale attivo il helper non prosegue al caricamento dell'inbox finché il redirect
autentico a `/dashboard` non è concluso. Se tale contratto fallisce, prima del cleanup salva una
diagnostica minimizzata con fase, path corrente e soli indicatori booleani per redirect e messaggio
di login; non legge né registra cookie, password, token, hash, header o dump di environment.

Gli assert DB controllano attribution N13, owner, versioni, sequenze activity, session id registry,
timestamp/outcome SLA e assenza di record N15. Screenshot ed evidenze JSON contengono esclusivamente
identità `.invalid`; l'ingresso browser CRM, come quello WordPress, è pubblicato solo su loopback.

## Risorse e limiti

I servizi `crm-n14` e `crm-browser-proxy` appartengono al solo profilo Compose sintetico `n14` e
usano il database già marcato dal sentinel VNX03. Worker, scheduler, dispatch, provider, egress e
N15 restano spenti. Non vengono contattati sistemi reali, non si invia alcuna comunicazione e non
si effettua alcun collaudo o attivazione di produzione. Il cleanup VNX03 rimuove container, reti,
volumi, immagini candidate e directory runtime creati dal job, lasciando solo evidenze minimizzate.
