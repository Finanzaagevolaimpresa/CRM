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
Playwright verifica login reale, visibilità dell'item non assegnato, due claim concorrenti con una
sola ownership/activity persistita, reload, registrazione della prima risposta e ciclo SLA `MET`.
Un secondo commerciale non vede né apre il Lead assegnato; anonimo e utente inattivo non accedono.

Gli assert DB controllano attribution N13, owner, versioni, sequenze activity, session id registry,
timestamp/outcome SLA e assenza di record N15. Screenshot ed evidenze JSON contengono esclusivamente
identità `.invalid`; l'ingresso browser CRM, come quello WordPress, è pubblicato solo su loopback.

## Risorse e limiti

I servizi `crm-n14` e `crm-browser-proxy` appartengono al solo profilo Compose sintetico `n14` e
usano il database già marcato dal sentinel VNX03. Worker, scheduler, dispatch, provider, egress e
N15 restano spenti. Non vengono contattati sistemi reali, non si invia alcuna comunicazione e non
si effettua alcun collaudo o attivazione di produzione. Il cleanup VNX03 rimuove container, reti,
volumi, immagini candidate e directory runtime creati dal job, lasciando solo evidenze minimizzate.
