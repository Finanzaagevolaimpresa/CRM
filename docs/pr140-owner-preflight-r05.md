# PR140 — unico preflight proprietario R05

Eseguire dal PowerShell del profilo Windows che già accede con l'alias fai-crm-prod, nella stessa lavorazione. Non cambiare ACL, configurazione SSH, credenziali o criteri di esecuzione.

Comando, dalla radice di questo checkout:

```powershell
& .\scripts\pr140\Invoke-OwnerPreflight.ps1
```

Il launcher usa OpenSSH con BatchMode, StrictHostKeyChecking=yes e UpdateHostKeys=no. La chiave è utilizzata solo da OpenSSH: nessun suo contenuto viene acquisito. Il collector Python è inviato tramite stdin e non salvato sul VPS. Il target deve restituire hostname=fai-crm-prod-02 e user=faiadmin prima di ogni altro controllo.

Comandi remoti: hostname/utente del processo; disponibilità strumenti; docker version/info/ps/inspect limitati a metadati e flag ammessi; git rev-parse/status tracked-only sui due checkout noti; SHA256 dei soli SQL di migrazione; una connessione psql in transazione READ ONLY per ledger, conteggi aggregati e sessioni registry vive; spazio disponibile. Le sessioni concorrenti sono conteggiate, non ne sono letti query o dati.

Effetti: creazione del solo JSON locale PR140_OWNER_PREFLIGHT_RECEIPT.json accanto allo script, senza sovrascrivere ricevute precedenti. Sul target nessun deploy, riavvio, backup, migrazione, DDL/DML, modifica di file o configurazione. PostgreSQL può registrare la normale attività di connessione/lettura nei propri log.

Non vengono letti environment integrali, chiavi, cookie, token, documenti cliente, contenuti dei backup o cartelle di custodia. I valori inattesi dei flag sono redatti. La ricevuta distingue configurazione locale non leggibile, alias/profilo errato, trasporto e autenticazione rifiutata.

Restituire soltanto il JSON minimizzato alla task Desktop esistente «Locate FAI CRM approval dossier». In caso di errore, riportare soltanto il codice sintetico mostrato. Un errore di accesso non autorizza tentativi di aggiramento.

Questo preflight non crea il backup46 e non autorizza scritture produttive. Serve a fissare target e capacità per completare una sola proposta operativa concreta.
