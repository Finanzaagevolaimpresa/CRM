# Catalogo — allineamento sito R01

## Provenienza e perimetro

Incremento applicativo derivato dalla specifica Governance PR20, priorità 1B, e dalle fonti commerciali pubbliche riconfermate dalla Cabina il 13 settembre 2026. Nessuna scrittura WordPress o produzione è parte del delta.

La revisione storica `2026-07-12-v1` / `TERMS-v1` resta byte-caratterizzata con 11 servizi e prezzi originali. La composizione corrente `2026-09-13-v2` conserva le nove schede non cambiate, aggiunge revisioni per Ottimizzazione Aziendale AI e Progetti Digitali e introduce Consulenza fiscale e Pianificazione e ottimizzazione fiscale come identità separate.

## Condizioni rappresentate

- Ottimizzazione Aziendale AI è **Su preventivo**: comprende l'analisi e la roadmap concordate; software, automazioni, gestione continuativa e consulenza fiscale richiedono un distinto incarico pertinente.
- I due servizi fiscali sono **Su preventivo**. FAI cura inquadramento e coordinamento; la prestazione fiscale compete al professionista abilitato individuato nell'incarico. Non sono registrati nominativi, abilitazioni, compensi o risultati garantiti.
- Progetti Digitali ammette sette classificazioni validate: siti/landing, e-commerce, software/CRM/workflow, app/piattaforme, automazioni/dashboard, progettazione tecnica e integrazione hardware/software, marketing/sviluppo commerciale. Non sono sette nuovi servizi o prezzi.
- Richiesta, preventivo, formalizzazione dell'incarico, accredito, materiali completi e avvio restano fasi separate. Tempi e deliverable non pubblicati sono da concordare nell'incarico.
- Le condizioni `12 mesi + eventuali 6` e `massimo 3 ripresentazioni` restano proprie della gestione misure e non sono propagate alle schede interessate.

## Persistenza e compatibilità

`prepareServiceCatalogV2` verifica gli hash v1 prima di scrivere, opera in una transazione serializzabile, non sovrascrive conflitti e registra un audit minimizzato. Gli incarichi esistenti non vengono migrati: contratto, prezzo e riferimento storico restano invariati. Tutti i flag `checkoutEnabled`, `autoClientDeliveryAllowed` e `autoExternalActionAllowed` restano `false`.

## Raccordo ingressi successivo

Il successivo esecutore ingressi deve trasmettere `serviceCode` e, soltanto per `progetti_digitali`, uno dei sette `digitalProjectType` canonici. Deve chiamare `validateCatalogSelection` prima di persistere qualsiasi riferimento. La richiesta non deve richiedere bilanci o identificativi aziendali a un soggetto da costituire e non rappresenta accettazione, pagamento o avvio.

## Lifecycle

`deploy_required=YES`; `migration_required=NO`; `production_change_required=YES` al futuro rilascio; `runtime_revalidation_required=YES`. Nessun deploy, migrazione o cambiamento produttivo è stato eseguito.
