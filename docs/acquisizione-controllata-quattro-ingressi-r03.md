# Acquisizione controllata — quattro ingressi R03

## Perimetro

Percorso applicativo esclusivamente sintetico e disattivato per default (`CONTROLLED_INTAKE_MODE=synthetic` nel solo banco). Registra richieste manuali provenienti da WPForms 1265, WPForms 1098, WPForms 1485 ed email senza connettersi al sito o a caselle reali. Il flusso automatico autenticato 1265 esistente non viene modificato: una registrazione 1265 da questa UI dichiara `MANUAL_CONTINUITY`.

L'identità è il digest canonico di canale e ID sorgente. Un replay uguale restituisce lo stesso Lead; contenuto differente confligge; receipt, Lead e audit sono atomici. Il receipt e il Lead condividono l'UUID tecnico per una correlazione non ambigua senza schema nuovo. L'envelope `controlled-intake-v1` è validato, canonicalizzato e riletto dalla UI; non è testo libero.

## Semantica

- La selezione servizio viene ricalcolata nella transazione sulla revisione PR137: master attivo, `PUBLISHED`, validità temporale e contenuto/hash canonici.
- WPForms 1098 richiede tipologia digitale, obiettivo e funzioni. Materiali dichiarati restano esplicitamente non verificati.
- WPForms 1485 registra una richiesta amministrativa; riferimento incarico assente significa da riconciliare. Non registra pagamento, accredito, firma o avvio.
- Email registra esigenza/categoria e può classificare i servizi fiscali, senza leggere caselle.
- Persona, impresa, professionista, soggetto da costituire, associazione, cooperativa ed ente sono ammessi senza imporre partita IVA o azienda.
- Email coincidenti non fondono richieste: gli ID dei possibili duplicati vengono segnalati per decisione umana, inizialmente nulla.
- La presa in carico assegna il Lead all'operatore autorizzato e conserva operatore, fonte, data, modalità, mapping, classificazione e riferimento catalogo.

## Sicurezza e lifecycle

Il writer richiede sessione registry viva e `lead.write`, rilegge l'autorità nella transazione e verifica configurazione, target loopback e sentinel fisico prima delle scritture. La pagina richiede `lead.read` e applica il filtro ABAC esistente; il modulo richiede anche `lead.write`. Nessun ruolo o permesso è aggiunto.

`deploy_required=YES`; `migration_required=YES`; `production_change_required=YES` soltanto a un futuro rilascio autorizzato; `runtime_revalidation_required=YES`. La migrazione additiva è destinata soltanto al PostgreSQL effimero CI; nessun deploy, migrazione o cambiamento produttivo è stato eseguito. Gli ingressi sono `RECORDED` oppure `ENROLLED` solo quando il servizio N14 crea realmente inbox, ciclo SLA e attività; N15, provider, invii, pagamenti e avvii automatici restano disattivati.


## Estensione R04

La migrazione additiva `20260914090000_controlled_intake_four_channels_v1` segue senza alterarle le 44 migrazioni PR137. Introduce registrazione tipizzata, candidati duplicato e decisione umana; note Lead, pagamenti e avvii restano indipendenti. Riferimenti amministrativi dichiarati e relazioni verificate sono distinti. Il percorso manuale 1265 resta distinto dal trasporto autenticato.

## Completamento R05

Tutti i writer (registrazione, decisione duplicato e raccordo 1265 autenticato) restano fail-closed quando la modalità sintetica è disattivata e validano i rispettivi comandi prima del dominio. I replay ricostruiscono candidati e decisione in base all'ABAC corrente; la consultazione usa `lead.read`, mentre creazione, classificazione e decisione richiedono `lead.write` e ambito modificabile.

Il raccordo 1265 è utilizzabile dalla pagina soltanto per ledger N13 con inbox N14 `BUSINESS_PROJECTION_N13`, form `1265` e Lead accessibile. La classificazione umana successiva conserva ledger, catalogo e modalità `AUTHENTICATED_AUTOMATIC`, distinta da `MANUAL_CONTINUITY`. Per WPForms 1485 il riferimento dichiarato resta testo separato: un preventivo/incarico diventa verificato solo se visibile e pertinente alla stessa identità email della pratica; altrimenti la registrazione resta da riconciliare o viene rifiutata.

La CI verifica i blob delle 44 migrazioni PR137, applica prima il ledger 44 e poi la sola migrazione additiva 45 nel PostgreSQL effimero del job ingressi. I drill N05 e il banco storico N15 continuano separatamente con le 44 migrazioni e non attestano recovery dello schema 45.

## Qualifica finita R06

Il checkout candidato schema 45 non viene più alterato per eseguire qualifiche storiche. La CI prepara un worktree detached dell'esatto commit PR137 `c49b18ccc4df713e212e8e4f2f05100638aee317`, tree `064415e3dbb4a7d4ac1498c24808a01342de2359`, per applicare e misurare il ledger 44; applica poi la migrazione 45 dal checkout candidato integro. N15, smoke/VNX05 e restore N05 usano sorgenti storiche esatte e mantengono la provenienza schema 44.

La fixture 1265 passa dal ciclo applicativo `admitBusinessInboxEvent` → `claimBusinessQueueEvent` → `projectClaimedLeadInboxEvent`, con chiave N13 esclusivamente sintetica in directory temporanea. Il browser riceve una seconda proiezione non ancora collegata e crea dalla UI il nuovo `ControlledIntake`; il replay resta verificato separatamente. Le prove HTTP catturano la server action dalla richiesta autorizzata e ripetono lo stesso POST con una sessione priva di autorità, verificando l'assenza di mutazioni.
