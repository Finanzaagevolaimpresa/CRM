# Collaudo ruoli, permessi e workflow operativo CRM FAI

Ambiente: solo `APP_ENV=development` / `NODE_ENV=development`.
Password demo per tutti gli utenti seed: `ChangeMe123!`.

## Precondizioni

1. Eseguire `npm ci`.
2. Eseguire `npm run prisma:generate`.
3. Eseguire seed in development con database locale disponibile.
4. Verificare che non esista alcuna area cliente pubblica, portale cliente, invio email automatico, WhatsApp automatico o invio automatico di output AI al cliente.

## Checklist ruoli e permessi

| Ruolo | Credenziali demo | Cosa deve vedere | Cosa non deve vedere | Azioni consentite | Azioni bloccate | Esito test |
| --- | --- | --- | --- | --- | --- | --- |
| admin | `admin@fai.local` / `ChangeMe123!` | Tutti i lead, clienti, progetti, servizi, documenti anche sensibili, AI, dossier, contratti, pagamenti, audit e settings. | Nessuna area cliente pubblica o invio automatico AI. | Gestione utenti, ruoli, settings, upload/download documenti, lettura sensibili, approvazione AI, modifica contratti/pagamenti/task/servizi. | Nessun fallback admin non autenticato. | Da eseguire |
| direzione | `direzione@fai.local` / `ChangeMe123!` | Vista direzionale completa su dati operativi, documenti sensibili, AI, dossier, contratti, pagamenti e audit. | Modifiche tecniche non previste fuori da `settings.manage` configurato. | Consultazione completa, approvazione AI, gestione servizi secondo permessi. | Azioni non esposte da UI o non coperte dai permessi. | Da eseguire |
| commerciale | `commerciale@fai.local` / `ChangeMe123!` | Lead e clienti demo assegnati commercialmente; progetti collegati ai propri clienti. | Clienti/progetti non assegnati e documenti sensibili non autorizzati. | Creazione/aggiornamento lead e clienti secondo permessi; assegnazione servizi se consentita. | Download documenti sensibili, audit/settings, pagamenti/contratti amministrativi. | Da eseguire |
| consulente | `consulente@fai.local` / `ChangeMe123!` | Cliente, progetto e servizi demo assegnati; documenti non sensibili scaricabili; output AI da revisionare. | Clienti/progetti non assegnati e documenti sensibili senza permesso. | Upload documenti, aggiornamento progetti/servizi assegnati, run/review AI, dossier operativo. | Approvazione AI finale, settings, download sensibili. | Da eseguire |
| revisore | `revisore@fai.local` / `ChangeMe123!` | Output AI e dossier da revisionare; documenti necessari inclusi sensibili; audit operativo se previsto. | Settings tecnici e modifiche amministrative. | Review/approvazione AI e dossier, download documenti sensibili autorizzati. | Creazione utenti, modifica pagamenti/contratti, upload se non autorizzato. | Da eseguire |
| backoffice | `backoffice@fai.local` / `ChangeMe123!` | Task e documenti demo assegnati, fascicolo operativo e documenti non sensibili. | Documenti sensibili non autorizzati; contratti/pagamenti riservati amministrazione. | Upload documenti, gestione task/servizi operativi. | Download sensibili, settings, approvazione AI finale. | Da eseguire |
| amministrazione | `amministrazione@fai.local` / `ChangeMe123!` | Contratti, pagamenti, contabili pagamento e documenti sensibili amministrativi. | Settings tecnici e workflow AI non amministrativi. | Lettura/modifica contratti e pagamenti; download sensibili autorizzati. | Creazione utenti, upload documenti se non autorizzato, approvazione AI se non prevista. | Da eseguire |
| collaboratore_limitato | `collaboratore@fai.local` / `ChangeMe123!` | Solo il cliente demo specifico assegnato al collaboratore e relativi elementi assegnati/non sensibili. | Fascicoli, progetti, servizi, task e documenti non assegnati; tutti i documenti sensibili non autorizzati. | Consultazione limitata e download non sensibili assegnati. | Settings, audit, lead globali, download sensibili, contratti/pagamenti, AI approval. | Da eseguire |

## Collaudo documenti sensibili

Categorie da verificare nel fascicolo demo: CRIF/Centrale Rischi, documenti identità, bilanci, estratti conto, contratti, contabili pagamento.

- I ruoli con `document.sensitive.read` (`admin`, `direzione`, `revisore`, `amministrazione`) devono poter scaricare i documenti sensibili se autenticati e autorizzati.
- I ruoli senza `document.sensitive.read` (`commerciale`, `consulente`, `backoffice`, `collaboratore_limitato`) devono ricevere blocco al download dei sensibili.
- Ogni accesso sensibile deve generare `document_sensitive_access` in `AuditLog` prima del download effettivo.
- Ogni download autorizzato deve generare `document_download` in `AuditLog`.

## Collaudo utente disattivato

Utente demo: `disattivato@fai.local` / `ChangeMe123!`.

1. Tentare login: deve fallire perché `active=false`.
2. Disattivare un utente già loggato da `/settings/users`.
3. Alla richiesta successiva l’utente deve essere bloccato, perché la sessione rilegge `role` e `active` dal database e non dal cookie.
4. Verificare evento `blocked_inactive_user_access` in `AuditLog`.

## Audit log da verificare

Eventi attesi: `login`, `logout`, `user_create`, `user_role_change`, `user_deactivate`, `document_upload`, `document_download`, `document_sensitive_access`, `ai_approval`, `contract_modify`, `payment_register`, `client_service_status_change`, `task_complete`.

## Esito finale

Compilare la colonna **Esito test** con `OK`, `KO` o note operative dopo aver completato il collaudo manuale multiutente.
