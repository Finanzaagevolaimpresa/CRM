# Modifica selettiva lead: primo nucleo di controllo

Stato: preparazione locale, non integrata nelle route, non distribuita. La base è
il merge PR210 (`d6a5a3d14a9b3a1ade0d33e6b156ad71da5d9b0f`, schema 62).
Il riallineamento conserva i soli moduli puri e documenti di questo incremento;
non attiva capacità di modifica o autorità personali in produzione.

Il catalogo di modifica comprende soltanto interesse e priorità. Ogni campo deve
anche essere leggibile nella concessione sottostante. Il payload di lettura
storico e la sua firma non cambiano: la capacità di modifica lega il preciso ID,
la revisione e la firma della concessione. Sostituzione, revoca o scadenza della
lettura invalidano la capacità. Una capacità non può superare la durata della
lettura e non è concessa per default.

Il protocollo crittografico della modifica è distinto da quello della lettura e
richiede un'autorità personale operativa `lead-edit` separata. Il codice non crea
questo binding né riusa implicitamente `lead-sharing`. Nessuna SQL o nuova
autorità produttiva è inclusa in questa preparazione.

Il comando accetta soltanto i campi scelti e una versione corrente esatta del
lead. Rifiuta il form commerciale ordinario, owner, stato, note, recapiti, chiavi
extra e valori impliciti. Non modifica provenienza del sito, Inbox, SLA, consensi
o assegnazioni. Il nucleo è puro: non effettua alcuna scrittura.

Le anteprime della scelta Admin e della modifica concreta usano scopi di firma
distinti. Il token lega contenuto, sessione, versioni della lettura e della
capacità, generazioni di attore/destinatario/lead e stato corrente. Dura al massimo
cinque minuti, ridotti alla prima scadenza pertinente. Il servizio dovrà calcolare
questi dati da fatti correnti verificati sotto lock; non può accettarli dal form.
Un token di anteprima non è una ricevuta di esecuzione o un comando persistito.

Il protocollo puro della ricevuta conserva solo contesto, digest del comando,
versioni e nomi dei campi; rifiuta vecchi/nuovi valori e attributi aggiuntivi.
La consultazione richiede ancora la concessione di lettura e la capacità di
modifica valide. Il modulo non dimostra un commit DB: il servizio dovrà salvare
modifica, audit, comando e ricevuta atomicamente. Cinque controprove specifiche
coprono sostituzione del comando, firma di altro scopo, campi estranei e revoca.

Il modulo server `selective-lead-edit-transaction.ts` prepara ora il wrapper
serializzabile: chiave registrata, directory, identità, due autorità distinte,
utenti ordinati e sessione autorevole. La lettura sotto lock ricontrolla lead,
concessione firmata, revisione, comando, ricevuta e audit della lettura. Nessuna
route lo richiama; le tabelle sono ancora una bozza SQL esterna alla catena
Prisma. Questi controlli non sono una
qualifica PostgreSQL della transazione: le prove DB rimangono in CI.

I moduli `selective-lead-edit-access`, `selective-lead-edit-service` e
`selective-lead-edit-management` implementano ora l'ammissione della capacità,
anteprima/conferma della modifica, consultazione della ricevuta e scelta/revoca
Admin con step-up. La conferma conserva aggiornamento, comando, audit e ricevuta
in una sola transazione; il replay controlla identità, sessione, digest e
autorizzazioni correnti. La revoca può riguardare un destinatario disattivato e
non ripristina la lettura. Questi percorsi non hanno ancora chiamanti nel prodotto
e non sono stati qualificati su PostgreSQL: la sola compilazione non attesta
atomicità, concorrenza o compatibilità della bozza SQL.

## Integrazione ancora necessaria

- Qualificare su PostgreSQL la bozza SQL e i nuovi servizi, compreso l'ordine
  dei lock con i writer ordinari e con le revoche.
- Interfaccia di anteprima e conferma esplicita sul protocollo già preparato;
  comando, cambiamento, audit minimizzato e ricevuta persistiti atomicamente.
- Replay dello stesso comando dopo risposta persa, senza nuova mutazione né
  divulgazione di dati dopo revoca. I controlli di versione non sostituiscono
  deduplicazione, lock e vincoli del database.
- Interfaccia Admin per autorizzare separatamente la modifica e interfaccia del
  destinatario che carica soltanto i valori ammessi.
- Piano concreto per SQL/binding, prove PostgreSQL e browser sintetiche in CI,
  recuperabilità, stesso revisore e specifica autorizzazione prima di produzione.

Le prove pure verificano firma distinta, lettura senza capacità, revisione
sostituita, scadenza, generazioni, identità inattive, diniego esplicito e rifiuto
di campi o versioni estranei. Non attestano sessioni reali, concorrenza DB, audit
atomico o comportamento del browser: queste prove restano da eseguire.

Verifica incrementale: il primo commit ha superato 7 prove di modifica e 13
regressioni della lettura. Il delta anteprima ha superato 5 nuove prove più le 7
di modifica, lint mirato e typecheck. Le 13 regressioni di lettura restano
attribuite al primo commit; non sono dichiarate rieseguite sul delta successivo.
