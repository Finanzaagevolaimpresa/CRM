# Pratica da preventivo ad avvio R01

Percorso applicativo sintetico e disattivato per default (`PRACTICE_READINESS_MODE=synthetic`). La migrazione additiva 46 introduce `PracticeReadiness`, `PracticeFundingEvidence` e `PracticeMaterialEvidence`; le 45 migrazioni precedenti restano invariate. Nessuna migrazione o attivazione produttiva è stata eseguita.

La pratica lega richiesta controllata, snapshot del preventivo accettato, revisione catalogo, cliente e progetto. Formalizzazione, accrediti, decisioni sui materiali, completezza e avvio sono comandi distinti e transazionali. L'accredito usa `Decimal(18,2)` e una chiave univoca pratica+riferimento; un replay divergente confligge. L'avvio umano richiede incarico formalizzato, accrediti confermati almeno pari all'importo iniziale concordato e una checklist non vuota interamente valida/non necessaria con motivazione.

`deploy_required=YES`; `migration_required=YES`; `production_change_required=YES` al futuro rilascio; `runtime_revalidation_required=YES`. Questa consegna autorizza soltanto software e PostgreSQL/browser effimeri CI.
