# N15 — collegamento sintetico assegnazione e consultazione (R03)

## Perimetro

Questa prosecuzione riusa l'assegnazione N14 e le tre tabelle dedicate N15 già qualificate. Non aggiunge
migrazioni: la catena resta di 44 directory e le migrazioni storiche non cambiano. L'unico scenario ammesso
è un database PostgreSQL effimero locale, identificato dal sentinel di test, con ambiente test/development e
opt-in esatto `N15_SYNTHETIC_ASSIGNMENT_V1`. Il default è disattivato.

## Composizione atomica e autorità

L'assegnazione rimane autorizzata dal registro sessioni e dal permesso `lead.inbox.assign`. Nella stessa
transazione serializzabile, dopo aver bloccato lead e inbox item, N14 verifica che il destinatario esista,
sia attivo e abbia ruolo commerciale. Solo il valore verificato `assigneeAfterId` dell'attività immutabile
diventa il destinatario interno dell'intento N15. L'id dell'attività è l'identità dell'intento e l'id dell'item
è la correlazione business: replay, conflitti e hash restano quelli del contratto Phase 1A.

Lead, item, attività, audit N14, intento RECORDED, decisione terminale HELD e audit N15 fanno parte della
stessa transazione. Qualunque errore o fault sintetico annulla l'intero insieme. HELD non è inviato, accodato
o consegnato; non esistono provider, endpoint, body, worker o nuovo stato.

## Consultazione

La scheda lead interroga il confine dedicato soltanto quando lo stesso opt-in sintetico è ammesso. Il server
ripete sia `lead.read` sia l'ABAC già usato dal lead: direzione/admin possono consultare e il commerciale può
consultare soltanto il lead assegnato a sé. La query parte dalle attività `ASSIGNED` del lead, limita il
producer sintetico e rivalida envelope, decisione e hash prima di proiettare solo destinatario interno,
orario e stato HELD. Un accesso diretto non autorizzato fallisce chiuso senza restituire canonical payload.

## Rollback applicativo

Disattivare o omettere l'opt-in rimuove sia la composizione sia la vista senza cancellare schema o righe.
N11, self-claim sintetico R02 e storage N15 rimangono invariati. Nessun utilizzo con dati reali è qualificato.

## Qualifica browser sintetica

Il job GitHub Actions dedicato riusa PostgreSQL effimero e Playwright dei runner già autorizzati. Crea un responsabile e una chiave step-up
solo sintetici, esegue l'assegnazione dalla UI reale e verifica il medesimo aggregate dal database. Lo screenshot
mostra la scheda al responsabile; una seconda sessione prova la vista dell'assegnatario e una terza prova il
rifiuto dell'accesso diretto. La ricevuta dichiara esplicitamente assenza di invio e accodamento. Il processo applicativo viene terminato dal trap e il service PostgreSQL è eliminato dal runner; vengono conservate soltanto le evidenze minimizzate per 14 giorni.

### Bootstrap client nel banco development

Il router development di Next 16.3.4 blocca le risorse interne `/_next` richieste in modalità `no-cors` da
un sito cross-site quando non dispone di un `Referer` ammissibile; la policy `no-referrer` del CRM non viene
indebolita. `crossOrigin: 'anonymous'` fa caricare gli script bootstrap in modalità CORS senza credenziali,
così il browser conserva l'origine concreta. L'allowlist development aggiunge esclusivamente il loopback
`127.0.0.1`, usato dal banco, e non ammette `null`, wildcard o host esterni. `crossOrigin` determina
l'attributo standard degli script anche nei build applicativi; l'allowlist opera soltanto nel server dev.
Non sono state cambiate dipendenze. Il test attende inoltre un marker React post-idratazione prima di ogni
Server Action del percorso, senza iniettare header, cookie o sessioni.

La consultazione dello storico N15 applica un confine più stretto della normale lettura lead: richiede sempre
`lead.read` e consente i ruoli con accesso globale oppure l'utente attualmente assegnato. Dopo un rilascio il
lead ordinario resta consultabile secondo l'ABAC generale, ma lo storico N15 viene omesso per ex assegnatario
e altri utenti non globali; il responsabile globale conserva la vista. Il confine server ripete la verifica.
