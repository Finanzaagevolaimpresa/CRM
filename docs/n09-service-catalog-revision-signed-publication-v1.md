# N09 — Service Catalog Revision & Signed Publication v1

## Stato e perimetro

N09 rende il CRM autorevole per identità stabile, revisione, prezzo, IVA, valuta, validità e condizioni operative degli 11 servizi FAI. WordPress resta autorevole per il testo SEO e continua a renderizzare senza chiamate sincrone al CRM.

La foundation non pubblica nulla verso WordPress, non registra chiavi, non crea snapshot firmati, non abilita checkout o Stripe e non introduce egress. La firma e la distribuzione del primo snapshot richiedono una successiva autorizzazione esplicita.

## Catalogo canonico

Tutti gli importi sono netti, in EUR, con IVA al 22% (`vatRateBps=2200`), validità dal 12 luglio 2026 e condizioni `TERMS-v1`.

| Ordine | Codice stabile | Servizio | Modalità | Prezzo netto |
| ---: | --- | --- | --- | ---: |
| 1 | `verifica_ai_essenziale` | Verifica AI Essenziale | fisso | €190 |
| 2 | `audit_ai_bancabilita` | Audit AI Bancabilità | fisso | €390 |
| 3 | `pre_analisi_ai_ammissibilita` | Pre-Analisi AI Ammissibilità | fisso | €490 |
| 4 | `consulenza_strategica_60` | Consulenza Strategica 60 minuti | fisso | €500 |
| 5 | `dossier_preanalisi` | Dossier Preanalisi | fisso | €890 |
| 6 | `ottimizzazione_ai_progetto` | Ottimizzazione AI Progetto | fisso | €1.250 |
| 7 | `business_plan_presentazione_bancaria` | Business Plan & Presentazione Bancaria | fisso | €1.690 |
| 8 | `ottimizzazione_aziendale_ai` | Ottimizzazione Aziendale AI | fisso | €1.490 |
| 9 | `progetti_digitali` | Progetti Digitali | preventivo | — |
| 10 | `gestione_misure` | Gestione misure | preventivo | — |
| 11 | `rendicontazione` | Rendicontazione | preventivo | — |

Il registro commerciale approvato è prevalente per il prezzo di **Ottimizzazione Aziendale AI**: €1.490 + IVA. La precedente sintesi “su preventivo” non viene propagata. Le varianti storiche di gestione e rendicontazione sono aggregate nelle due identità pubbliche e rimangono “su preventivo”.

I codici delle prime tre voci restano invariati per preservare i riferimenti esistenti. Le righe legacy `supporto_finanza_ordinaria` e `supporto_finanza_agevolata` vengono soltanto disattivate: non sono eliminate e gli eventuali `ClientService.serviceCatalogId` storici restano validi.

## Modello revisioni

La migration 37 aggiunge:

- `ServiceCatalogRevision`, con versione positiva, modalità prezzo coerente, EUR canonico, IVA espressa in basis point, intervallo di validità, condizioni, checklist, hash SHA-256 e controlli fisici che mantengono checkout, consegna automatica e azioni esterne disabilitati;
- `ServiceCatalogPublication`, registro append-only di snapshot firmati, inizialmente vuoto;
- un solo indice parziale per revisione `PUBLISHED` di ciascun servizio;
- trigger che impediscono modifica o cancellazione del contenuto pubblicato. È ammesso soltanto il passaggio atomico `PUBLISHED → RETIRED` con `retiredAt`, senza variazioni al contenuto;
- trigger append-only per le pubblicazioni firmate.

La migration inserisce le 11 revisioni v1 e aggiorna in modo idempotente le identità del catalogo. Non modifica contratti, pagamenti, incarichi cliente o dati operativi.

## Snapshot firmato dormiente

`buildServiceCatalogPublicSnapshot` produce un payload deterministico e minimizzato: codice, versione, nome pubblico, modalità e importo, EUR, IVA, validità, versione delle condizioni, flag checkout e soli codici delle condizioni pubblicabili. Descrizioni SEO, checklist interne, payload grezzi e dati cliente sono esclusi.

`signServiceCatalogSnapshot` e `verifyServiceCatalogPublication` implementano HMAC-SHA-256 su JSON canonico con:

- chiave esplicita di almeno 32 byte, mai letta dall’ambiente;
- versione chiave positiva;
- hash SHA-256 del payload;
- firma Base64URL senza padding;
- verifica anti-manomissione a tempo costante.

La foundation è pura: nessun accesso a database, ambiente, rete, WordPress o Stripe. La migration non inserisce righe in `ApplicationKeyVersion` né in `ServiceCatalogPublication`.

## Gate e rollback

I gate N09 verificano 11 servizi univoci, 8 a prezzo fisso e 3 su preventivo, immutabilità SQL, minimizzazione e firma deterministica, assenza di attivazioni e conteggio di 37 migration.

Il codice applicativo resta compatibile con lo schema precedente e legge ancora `ServiceCatalog`. In caso di rollback applicativo alla release N08, le nuove tabelle e le 11 revisioni sono additive e non richiedono down migration. Il rollback non elimina i dati N09; una rimozione o una pubblicazione reale richiede un change separato.
