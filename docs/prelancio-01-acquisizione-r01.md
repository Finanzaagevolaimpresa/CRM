# PRELANCIO-01 — raccordo WPForms e presa in carico

Osservazione pubblica in sola lettura del 05/10/2026:
<https://finanzaagevolaimpresa.it/contatti/>, form DOM `wpforms-form-1265`.
Nessuna submission effettuata sul sito. La pagina è un candidato di acquisizione;
la destinazione effettiva della campagna non è attestata da questa osservazione.
Una conferma WPForms non prova la persistenza nel CRM.

## Mapping riscontrato e candidato

| Campo pubblico | Destinazione proposta |
| --- | --- |
| 1, nome composto | `firstName: {field_id: 1, part: first}` e `lastName: {field_id: 1, part: last}` |
| 2 email, 3 telefono, 4 azienda | `email`, `phone`, `companyName` |
| 5 servizio richiesto | `serviceInterestText`, senza inventare un codice catalogo |
| 9 obiettivo | `interestText` |
| 6 fase, 7 riferimento, 8 URL, 10 descrizione, 11 interventi | Parti esplicite di `message` con etichetta |
| 12 tipologia, 13 fascia investimento, 14 tempi, 15 documenti, 17 note | Ulteriori parti di `message` con etichetta |
| 19 informativa richiesta | Riconoscimento informativa di servizio; valore esatto del callback ancora da attestare |
| 109 dichiarazione B2B/professionista | Requisito del form, non consenso marketing |
| 16/18 campi ausiliari e campi step/HTML | Esclusi dal mapping |

Il campo 13 contiene fasce e «Da definire»: **non** mapparlo a `requestedAmount`.
`requested_amount_mode` resta null. La scelta servizio non costituisce da sola
una pubblicazione o selezione del catalogo: `catalog_reference` resta null fino
alla qualificazione e decisione previste da N14.

Il connettore 1.2.0 supporta solo i componenti nome `first`/`last` del campo
WPForms sanitizzato di tipo `name`. Non legge POST grezzi e non separa a intuito
un nome completo. `message.parts` ammette 1–12 campi con etichette esplicite;
ambiguità, duplicati, sovrapposizioni con campi privacy e componenti assenti
vengono respinti. Restano i limiti contrattuali: 4.000 caratteri per messaggio
e 16 KiB per envelope; niente troncamenti silenziosi. Prima del cutover occorre
allineare i limiti del form e provare il caso massimo; la conferma pubblica
non deve diventare l'unica prova di consegna dopo un errore del produttore.

## Privacy e scelta Q05

Nel DOM osservato **non è presente** una scelta marketing Sì/No. Non associare
il consenso alla richiesta di servizio, alla dichiarazione B2B o all'informativa
obbligatoria. Il ramo marketing non può essere inventato dal connettore.

La scelta Sì/No per la preparazione è già deliberata: non richiede una nuova
decisione generica. Si preservano le etichette della proposta Q05/R43 recuperata,
da pubblicare solo dopo verifica dell'informativa esatta:

- Domanda: «Vuoi ricevere via email comunicazioni promozionali sui servizi FAI?»
- Sì: «Si, desidero ricevere comunicazioni promozionali via email.»
- No: «No, non desidero ricevere comunicazioni promozionali via email.»

Radio senza preselezione, risposta esplicita Sì o No, rifiuto senza ostacolo alla
richiesta; l'assenza di risposta non viene trasformata in DENIED. Il callback
confronta l'etichetta sanitizzata, non `value_raw`. L'ID110 è solo una fixture.
Canali, titolare, revoca e finalità devono corrispondere al testo effettivo.
La scelta non autorizza campagne o invii. R13 rimane dormiente.

Fonte Q05 recuperata sull'MSI: `MAPPING_PROPOSTO.json`, 5.410 byte,
SHA256 `a3715eceaa550865977d7866dc7fbff2ba4105c255a149aeb9b1897dc04247ec`
ricontrollato sui byte il 05/10. Il mapping minimo storico resta supportato;
nome composto e message.parts sono opzioni aggiuntive del candidato1.2.0.
Q05 non attestava accesso produttivo alla richiesta originale completa.
La proposta R43 di conservazione e revoca resta una proposta: non è resa policy
approvata o funzione attiva da questo documento. Non pubblicare un richiamo alla
pagina Preferenze email prima che esistenza e blocco siano qualificati.

La Cabina ha recuperato una decisione commerciale sul solo VAE190; la fonte
descrive un facsimile, non la destinazione definitiva della campagna. Responsabile
N14/SLA e identità amministrativa WordPress non risultano attestati nelle fonti
recuperate. Tali limiti restano distinti dalla preparazione software già eseguita.

Per l'installazione servono ID effettivo del nuovo campo, valori sanitizzati
Sì/No, codice/versione delle due informative e hash dei testi approvati, versione
del form e percorso campagna. Sono dati da qualificare: nessun placeholder è
una configurazione produttiva valida. Per il campo19 verificare anche il valore
restituito dal callback rispetto al testo con link HTML visibile pubblicamente.
La bozza strutturata è `prelancio-01-wpforms1265-proposal.json`, non installabile.

## Catena di prova

Banco isolato già previsto dal repository: WordPress/WPForms autentico, MySQL
InnoDB, coda cifrata, HTTPS gateway N12, ricezione persistita, consumer VNX01,
proiezione lead e Commercial Lead Inbox N14, con Admin e commerciali sintetici.
Il candidato usa nel banco il campo nome composto e la composizione messaggio.
Le prove comprendono replay, richieste diverse, errore/ripresa, assegnazione
Admin, presa in carico, prossima azione e dinieghi fra operatori.

Riferimenti eseguibili: `.github/workflows/r05-n14-candidate.yml`,
`tests/vnx03/wpforms-https-e2e.spec.ts`, `n14-commercial-browser.spec.ts`,
`assert-n14-state.ts`, suite PHP e MySQL del connettore. Le ricevute del candidato
devono riportare commit/tree, schema49 e `productionContact=false`.
Le prove sintetiche non vengono presentate come prova di ingresso live1265.

## Gate operativo separato

Prima di installare: identificare host WordPress, amministratore, DB/schema e
prefisso tabella, plugin/versione, eventuale connector preesistente, backup e
rollback. Prima di configurare: validare mapping e informative, gateway effettivo,
key-id e percorsi privati delle due chiavi distinte; mai valori nelle ricevute.
Prima di attivare: autorità specifica su WordPress/plugin/coda InnoDB, consumer
e N14, destinatario responsabile esistente e una sola submission sintetica
tracciata. Non creare chiavi, tabelle, cron o worker con consenso implicito.

La prova live, quando autorizzata, segue lo stesso ID dalla submission fino a
ricevuta persistita, richiesta/lead, inbox, assegnazione, presa in carico e
prossima azione. Verificare dedup/replay e richiesta distinta, quindi errore e
recupero senza perdita o doppioni. Conservare ricevute minimizzate; evitare PII,
payload, chiavi e log privati. Un errore lascia il lancio pubblicitario sospeso,
senza cancellare code o dati e senza avviare campagne per provare il collegamento.
