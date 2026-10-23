# Incarichi tecnici multipli — primo incremento operativo

## Comportamento

L'autorità personale `technical-assignment` assegna responsabilità, operazioni, campi e versioni documentali a singoli tecnici. Più tecnici possono lavorare sullo stesso progetto o sulla stessa pratica. L'incarico non modifica il referente commerciale né il precedente responsabile principale e non si estende ad altri record.

Dalla scheda progetto o pratica, l'Admin personale apre **Gestisci incarichi tecnici e perimetri**, sceglie la persona, i campi leggibili/modificabili, le operazioni, le versioni dei documenti e la scadenza (massimo 90 giorni). Anteprima esatta e conferma personale con step-up precedono ogni assegnazione, modifica o revoca. Gli altri Admin non ereditano l'autorità.

Il tecnico apre **I miei incarichi tecnici**. Le operazioni disponibili in questo incremento sono la modifica dei soli campi esplicitamente assegnati e il cambio di stato tecnico ammesso. Ogni salvataggio ha un riepilogo prima/dopo, una versione ottimistica e un comando identificato. Il doppio clic non duplica la scrittura; una risposta persa richiede la verifica della ricevuta, senza ritentare automaticamente il comando. La ricevuta è legata anche alla sessione originaria.

La lettura dei documenti verifica versione, impronta, contesto e permessi correnti; anteprima e download sono distinti. Contratti, pagamenti e documenti finanziari sono esclusi anche con categoria fuorviante. I percorsi ordinari e il fascicolo generale del cliente assegnato restano limitati per impedire l'aggiramento attraverso precedenti relazioni con il cliente. La revoca o la scadenza non ripristinano tali percorsi. I cambi di proprietario, parentela, perimetro, chiave e ciclo di vita invalidano le ammissioni precedenti.

## Persistenza e recupero

Migration candidata `20261022200000_technical_assignments_v1`, schema 63→64, cinque tabelle vuote: autorità, incarichi, decisioni, revisioni e comandi di lavoro. Dieci vincoli esterni restrittivi; quattro controlli differiti vincolano incarico/decisione/storico/audit e lavoro/ricevuta/audit alla stessa transazione. Nessun enrollment o destinatario viene creato dalla migration.

Il modello Prisma rappresenta le cinque tabelle. `scripts/technical-assignments/schema-binding.json` lega SQL, modello e baseline PR214; tutti i prefissi storici restano invariati. Lo script operatore `ops/technical-assignment-authority-enrollment.sql` è distinto dalla migration e non viene invocato da app, route o startup. Il suo uso produttivo richiede un'approvazione specifica di profilo e piano.

Il recupero qualificato riguarda un riavvio della stessa immagine compatibile con schema64. PR140 confronta dati, epoche, documenti, incarichi, revoche, comandi e audit prima/dopo guasto e ripresa, con il controllo esistente sulle sessioni. Nessun down-migrate, ritorno a schema63, nuovo backup o restore database è compreso.

## Qualifica

Le prove pure coprono selezioni, domini di firma, versioni, giornale immutabile, ricevute, proiezioni e perimetri indiretti. Le nuove prove PostgreSQL e browser sono consentite esclusivamente nella CI effimera. Il workflow `technical-assignments.yml` esegue:

- Migration da schema63, rifiuto della base62, rollback atomico di un guasto, prefisso e dati precedenti conservati, strutture vuote e parità Prisma.
- Enrollment operatore isolato, rifiuti, concorrenza a singolo consumo e rollback dell'audit.
- 18 scenari PostgreSQL su due commerciali e due tecnici, concorrenza, revoca, scadenza, documenti utilizzabili, dinieghi e audit atomico.
- 4 percorsi browser nativi: assegnazioni multiple e lavoro, perdita di risposta, revoca con pagina aperta, progetto e ricerca. Screenshot desktop/mobile provengono dagli stessi percorsi.

PR140 aggiunge la verifica nell'immagine confezionata e nel suo riavvio. Le prove preparate non sono considerate superate fino all'esito sull'HEAD esatto.

## Limiti e passaggi successivi

Questo incremento non chiude il mandato complessivo. Richieste interne all'Admin, gestione checklist, scadenze e caricamento documenti sono azioni previste dal contratto futuro ma non concedibili qui. Nessun invio email, provider, cron o binding reale deriva dallo sviluppo.

Restano separati il riesame indipendente, l'autorità specifica per SQL64/enrollment/merge/deploy e il collaudo umano operativo. La produzione rimane PR214/schema63 fino al rilascio autorizzato. I dati reali non sono fixture.

