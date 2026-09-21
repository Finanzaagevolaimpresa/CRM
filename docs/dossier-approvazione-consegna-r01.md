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
| ABAC/sessione/revoca/conflitto/replay/atomicità | attore ricaricato e lockato in ogni transazione, contesto corrente, guard documentali, serializable, fault audit e replay DB |
| UI desktop/mobile | griglie responsive e form nel percorso pratica/dossier esistente |

## Migrazione e lifecycle

La migrazione `20260920090000_engagement_dossier_approval_delivery_v1` è additiva: preserva integralmente le 46 migrazioni precedenti, aggiunge cinque tabelle e cinque riferimenti opzionali a `ClientDossier`. L'upgrade qualificato è 46→47. `deploy_required=YES`, `migration_required=YES`, `production_change_required=YES`, `runtime_revalidation_required=YES` sono necessità del successivo passaggio Desktop, non operazioni eseguite da Cloud.

## Rientro

Prima del merge si abbandona il ramo senza alterare main. Dopo il merge il rollback applicativo avviene con revert/addendum: lo schema 47 resta compatibile perché colonne e tabelle sono additive e i percorsi legacy tollerano valori null. Non eliminare tabelle, versioni, review, export, autorizzazioni o ricevute: un eventuale rientro dati richiede una PR separata e conservativa.

## Limiti

Nessun invio email, provider, worker, AI reale, dato cliente o accesso produzione. I test usano esclusivamente destinatari e ricevute marcati sintetici. Le roadmap Governance citate dal mandato non erano leggibili dall'ambiente (HTTP 401); questa guida deriva dai requisiti trasmessi e dal sorgente CRM verificato.
