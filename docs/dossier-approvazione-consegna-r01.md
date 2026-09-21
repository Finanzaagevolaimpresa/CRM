# Dossier versionato, approvazione e consegna manuale — R01

## Scopo

L'incremento F07 collega una `PracticeReadiness` già avviata, la revisione di servizio accettata, il servizio cliente, una preanalisi manuale e lo snapshot delle evidenze materiali a un `ClientDossier`. Non modifica né reinterpreta incarico, accredito, completezza o avvio.

## Flusso operativo

1. Dalla pratica avviata scegliere **Preanalisi → dossier e consegna** e selezionare una preanalisi dello stesso cliente/progetto.
2. Salvare la prima versione. Ogni modifica successiva crea una nuova `EngagementDossierVersion`; le versioni precedenti non vengono sovrascritte.
3. Un operatore distinto con `dossier.approve` richiede modifiche oppure approva ID e hash della versione corrente. Una nuova versione azzera l'approvazione.
4. Solo la versione approvata è esportabile in Markdown o DOCX. L'export registra formato, hash del contenuto approvato e hash dell'artefatto, ma **non** autorizza né registra una consegna.
5. L'approvatore crea un'autorizzazione separata con versione/hash e destinatari espliciti. Non viene effettuato alcun invio.
6. Un operatore autorizzato registra manualmente `DELIVERED` o `FAILED` con data e riferimento della ricevuta. Replay identici sono idempotenti; evidenze differenti sulla stessa autorizzazione producono conflitto.

## Matrice requisito → evidenza

| Requisito | Evidenza |
|---|---|
| Collegamento pratica/servizio/preanalisi/materiali | FK additive della migrazione 47; snapshot immutabile in `EngagementDossierVersion`; test PostgreSQL nel percorso A |
| Versioni, richiesta modifiche, approvazione esatta | `contentHash`, `currentVersionId`, `approvedVersionId`, `EngagementDossierReview`; test A v1→richiesta→v2→approvazione→v3 |
| Export coerente e separato | route Markdown/DOCX sulla sola versione approvata e `EngagementDossierExport` |
| Autorizzazione e ricevuta manuale | `EngagementDossierDeliveryAuthorization` e `EngagementDossierDeliveryReceipt`; nessun provider/worker |
| ABAC/sessione/revoca/conflitto/replay/atomicità | sessione canonica obbligatoria e lockata, contesto e documenti correnti anche per storico e riferimenti alla sola versione; test PostgreSQL di revoca, riassegnazione, archiviazione, fault audit e ricevute concorrenti |
| Percorsi legacy e contenuto esportato | POST browser con ID manipolato verso le azioni generiche rifiutati senza effetti; hash dei byte Markdown/DOCX confrontato con il record di export; nessuna nota cliente corrente aggiunta al DOCX approvato |
| UI desktop/mobile | griglie responsive e form nel percorso pratica/dossier esistente |

## Migrazione e lifecycle

La migrazione `20260920090000_engagement_dossier_approval_delivery_v1` è additiva e racchiusa in `BEGIN`/`COMMIT`: preserva integralmente le 46 migrazioni precedenti, aggiunge cinque tabelle e cinque riferimenti opzionali a `ClientDossier`. La CI verifica un errore SQL prima del commit: nessuna delle cinque tabelle o colonne deve restare installata. Successivamente applica l'upgrade 46→47 e controlla ledger e checksum; le altre suite verificano l'installazione completa. `deploy_required=YES`, `migration_required=YES`, `production_change_required=YES`, `runtime_revalidation_required=YES` indicano un futuro intervento produttivo, non eseguito da questa consegna.

## Rientro

Prima del merge main e produzione restano invariati. Un errore durante la migrazione 47 deve annullare l'intera transazione, come provato nella CI sul database effimero. Dopo la creazione di dossier versionati, un semplice ritorno alla vecchia applicazione non è ammesso: le azioni legacy precedenti non conoscono i nuovi vincoli di versione e ambito documentale. Il rientro applicativo deve conservare tali guard in una build correttiva verificata; lo schema 47 e le evidenze restano intatti. Non eliminare tabelle, versioni, review, export, autorizzazioni o ricevute. Il piano specifico di rilascio, backup e rientro produttivo richiede revisione e autorizzazione prima dell'esecuzione.

## Recupero e verifica

Il primo commit della PR riproduce esattamente il tree Cloud `2a090712ddc365e14b13d50eac4c56b7940e46a0`, riportato sulla base main `3230764a4406182e50d22236bb7e701d0f1b5656`. I commit successivi espongono separatamente le correzioni della verifica Desktop. L'integrità del patch originale è attestata dallo SHA-256 `3823696046083d5d897d0d364bc4f0390517a70e9e5b524937a882e2ff697a5c`. Gli esiti validi per la consegna sono quelli della CI sullo SHA finale, con test eseguiti e saltati distinti; le prove locali bloccate dal runtime Windows non sono conteggiate come superate.

## Limiti

Nessun invio email, provider, worker, AI reale, dato cliente o accesso produzione. I test usano esclusivamente destinatari e ricevute marcati sintetici. Le roadmap Governance citate dal mandato non erano leggibili dall'ambiente (HTTP 401); questa guida deriva dai requisiti trasmessi e dal sorgente CRM verificato.
