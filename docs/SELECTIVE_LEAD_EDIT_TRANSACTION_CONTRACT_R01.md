# Modifica selettiva lead: contratto dell'integrazione da implementare

Preparazione locale riconciliata sul merge PR210 e sullo schema 62. Le regole
seguenti non sono ancora un servizio operativo, una migration o una concessione
produttiva; richiedono l'integrazione e le qualifiche elencate sotto.

## Percorsi osservati

`src/lib/selective-lead-access.ts` conserva la decisione personale di lettura,
la sua revisione, il comando, l'audit e la ricevuta. Le letture ricontrollano lo
storico firmato e i permessi correnti. Il suo wrapper usa chiave registrata,
directory, lock d'identità, utenti ordinati, sessione autorevole e lead.

`src/lib/lead-lifecycle-lock.ts` e `src/lib/actions.ts` mostrano il percorso
ordinario di aggiornamento/conversione: sessione corrente, lock del lead,
versione esatta e vincoli N14. Il form commerciale modifica anche stato, note
e assegnazione. Non è il comando da esporre al destinatario selettivo.

La lettura selettiva non conferisce scrittura ordinaria. Il nuovo percorso deve
ammettere soltanto interesse e priorità, esplicitamente scelti anche per lettura.
La policy e i token puri già preparati non effettuano scritture né deduplicazione.

È stato aggiunto `selective-lead-edit-transaction.ts`: wrapper serializzabile e
caricamento dello storico di lettura sotto lock, ancora senza chiamanti runtime.
Usa i modelli esistenti per lettura/sessione/lead e una query parametrizzata
sulla futura tabella vuota `SelectiveLeadEditAuthority`; non crea la tabella o
il binding. Le scritture della capacità e del lead, i vincoli persistenti e le
prove concorrenti restano da implementare e qualificare prima dell'attivazione.

## Transazione e ordine da qualificare

1. Chiave registrata e directory; lock d'identità lead; autorità distinte di
   lettura e modifica con ordine fisso; utenti interessati ordinati e sessione
   autorevole. L'autorità `lead-edit` non deriva da `lead-sharing` o dal ruolo.
2. Lead corrente sotto lock di scrittura, concessione di lettura e capacità di
   modifica con ordine fisso. Rilettura di utenti, sessione, dinieghi, revisioni,
   generazioni, storico firmato, scadenze, cestino, archiviazione e conversione.
3. Comando identificato da UUID e digest del contenuto canonico; ricerca del
   precedente esito nello stesso perimetro. Un UUID riusato con altri dati,
   attore o contesto è rifiutato. Non deve aggiornare nulla.
4. Per una nuova esecuzione, anteprima esatta ancora valida, conferma esplicita
   e confronto della versione corrente. Aggiornamento dei soli campi scelti,
   timestamp monotono, audit minimizzato, comando e ricevuta in una transazione.
5. Nuova verifica di sessione e scadenze prima della conclusione. Il fallimento
   di audit, ricevuta o vincoli annulla l'intera modifica.

Questo ordine è un requisito da verificare contro tutti i writer ordinari,
conversione, cestino, sito e revoche: la sola policy pura non prova assenza di
deadlock o lost update. Non introdurre un secondo lock order per la ricevuta.

## Risposta persa e ricevuta

La ricevuta deve distinguere comando registrato da stato attuale del lead.
Contiene solo identificatori tecnici, revisione/versione e campi modificati;
non copia vecchi/nuovi valori, recapiti, note o informazioni non selezionate.
Un replay esatto può restituire la ricevuta già conservata soltanto dopo i
controlli correnti ammessi per quell'attore. Non ricostruisce contenuto revocato.
Se permessi o sessione non permettono più la consultazione, il comando rimane
registrato e la nuova lettura è negata: nessuna seconda mutazione o falsa
indicazione che l'operazione precedente non sia avvenuta.

La UI conserva UUID e contenuto della richiesta in caso di esito incerto, offre
la verifica della ricevuta e non genera automaticamente un nuovo comando.
L'assenza momentanea della ricevuta non prova che la prima richiesta sia fallita.

## Prove necessarie prima di una PR completa

- Sola lettura senza capacità; campo modificabile ma non leggibile; ruolo Admin
  senza binding; diniego esplicito; scadenza e revoca con sessione già aperta.
- Concorrenza con aggiornamento ordinario, conversione, cestino, sostituzione
  della lettura e disabilitazione dell'autorità: nessun aggiornamento parziale.
- Doppio clic e replay dopo perdita della risposta: un solo comando, cambiamento
  e audit; stesso UUID con contenuto diverso respinto.
- Errore audit o ricevuta iniettato: lead e storico integralmente invariati.
- Campi nascosti aggiunti al form, versione obsoleta e token di altro scopo,
  attore o sessione respinti. Nessuna mutazione tramite GET.
- Browser sintetico desktop/mobile: scelta Admin separata, riepilogo prima
  della conferma, form del destinatario limitato e messaggio sull'esito incerto.

Le nuove strutture persistenti e il binding personale avranno SQL, piano,
recuperabilità, riesame e autorizzazione specifici. Non sono inclusi nel consenso
SQL62 per i dati dei referenti. Nessun destinatario o lead reale è una fixture.

La bozza locale `SELECTIVE_LEAD_EDIT_SCHEMA_DRAFT_R01.sql`, esterna alla catena
Prisma, propone cinque tabelle vuote: autorità, capacità, decisione personale,
revisione e comando del destinatario. Gli identificatori dei comandi sono
univoci; decisione, revisione, audit e capacità hanno vincoli differiti nella
stessa transazione. Il comando del destinatario richiede un aggiornamento del
lead e l'audit minimizzato nella stessa transazione. Non conserva i valori
precedenti o nuovi nei registri dei comandi. La bozza non è stata eseguita:
enforcement dei campi, compatibilità della catena e controprove SQL richiedono
ancora qualifica PostgreSQL sintetica in CI, insieme al servizio completo.
