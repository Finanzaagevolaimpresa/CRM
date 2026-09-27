# M5 — servizi iniziali e consegne manuali

Incremento applicativo sullo schema49 di M4; nessuna migrazione aggiuntiva. Nessun plugin, API AI, provider, worker, scheduler o nuovo agente viene attivato.

## Servizi e responsabilità

| Servizio acquistato | Produttore Work | Risultato autonomo |
|---|---|---|
| Verifica AI Essenziale | A01 | Quadro preliminare, criticità e prossimo passo |
| Audit AI Bancabilità | A02 | Analisi documentale e numerica, ipotesi e limiti |
| Pre-Analisi AI Ammissibilità | A03 | Requisiti ufficiali confrontati con le evidenze |
| Dossier Preanalisi | A04 | Alternative, priorità e strategia motivata |
| Consulenza strategica 60 minuti | A08 | Preparazione della consulenza umana, agenda e quesiti |

Le schede nel dossier mostrano materiali, attività comprese ed esclusioni. Le integrazioni comprese completano il servizio acquistato; i successivi servizi rimangono opzionali. La preparazione A08 non attesta che la consulenza umana sia già avvenuta.

A00 → produttore → Q01 → Q02 → Q03 → gate umani → D01 → approvazione amministrativa finale → autorizzazione nominativa alla consegna → ricevuta manuale.

Si riusano gli identificativi A00–A11, Q01–Q03 e D01. La registrazione Work è un'attestazione dell'operatore responsabile con documento/versione effettivamente leggibile e verificato tramite SHA256, riferimento della lavorazione e della versione dell'agente dichiarata. Non equivale a un'attestazione software dell'esecuzione o della qualificazione di un plugin. Nessun riferimento produttivo viene inventato.

## Vincoli applicati dal server

- Configurazione amministrativa con step-up e identità correnti; responsabile e revisori sono utenti CRM attivi, autorizzati e nel perimetro del cliente. Ogni revisore registra personalmente il proprio giudizio.
- Tutti i giudizi sono vincolati a dossier, piano, versione e hash. Piano e giudizi sono ricevute aggiunte al registro AuditLog esistente con hash verificato; il codice applicativo non espone update/delete di queste ricevute. Nessuna nuova garanzia SQL di immutabilità dell'intero AuditLog viene dichiarata.
- Q02 è obbligatorio per Audit Bancabilità, analisi numerica, business plan e domande. Negli altri report l'eventuale non applicabilità è una decisione umana motivata; non è una fittizia esecuzione dell'agente Q02.
- Business plan/domande e contributi A07/A09/A10/A11 richiedono due revisori umani distinti fra loro e dal produttore. Mancanza o revoca bloccano il solo dossier.
- Cambiare assegnazioni comporta un nuovo piano e nuove revisioni. Le protezioni di rischio non possono essere ridotte in un piano successivo. Gli import Work ad alto rischio richiedono preventivamente il relativo contributo nel piano.
- Nuove versioni invalidano l'approvazione e la catena precedente. REQUEST_CHANGES richiede una nuova versione. Il salvataggio concorrente del medesimo passaggio non può produrre due giudizi validi.
- Prima di approvazione/export/autorizzazione/consegna si riverificano utenti, permessi, perimetri e bytes dei documenti di revisione. La scadenza naturale della vecchia sessione non annulla un giudizio storico; ne resta conservata la provenienza.
- Template per servizio con cliente, data, revisione, fonti e relativa data di verifica, limiti e prossimo passo. Il testo obbligatorio precisa che FAI non eroga finanziamenti, non promette contributi, non garantisce esiti o erogazioni e non opera come intermediario finanziario.
- Word include i bytes del logo originale public/logo-fai.png con hash 008df460afebcf2829a0e4e0ab00a8f02df9795be07f81feccbb4c1c078536df, rapporto d'aspetto conservato e collegamento OOXML interno. Il markdown conserva il riferimento al logo: non è un file auto-contenuto.
- Restano separati approvazione, autorizzazione con destinatario e dichiarazione di consegna. Nessuna ricevuta manuale dimostra automaticamente ricezione, lettura o immutabilità di un file aperto da un client esterno.

I dossier storici dei cinque servizi conservano versioni e ricevute. Per una nuova approvazione/consegna con M5 devono adottare il piano e completare le revisioni; un dossier già approvato richiede prima una nuova versione. Gli altri servizi conservano il percorso M2.

## Qualificazione prevista e limiti del rilascio

CI dedicata: cinque casi sintetici PostgreSQL dal preventivo/contratto/pagamento/materiali fino a consegna, atomicità dell'audit, bytes errati, concorrenza, revoca e gate duali. Browser Chromium: i cinque template, responsabile/revisore/admin con login personale, step-up, revisioni, download Word reale con logo estratto e verificato indipendentemente, destinatario e ricevuta sintetici.

Le prove CI non qualificano fonti finanziarie reali, versioni produttive degli agenti, persone da assegnare, caselle o consegne reali. Il rilascio produttivo richiede il riesame indipendente e le ricevute operative del candidato esatto. In un ritorno a una versione precedente a M5, M5 è indisponibile e le lavorazioni/consegne di questi dossier vanno sospese: il vecchio codice non contiene i nuovi gate. Schema49 e ricevute restano conservati; nessun downgrade o ripristino distruttivo.

Un conflitto di serializzazione durante l'export approvato, l'autorizzazione
alla consegna o la registrazione della ricevuta manuale interrompe e annulla
l'intera transazione. Le tre operazioni
ripetono al massimo tre tentativi soltanto per
questi aborti confermati (Prisma P2034 o SQLSTATE 40001/40P01), rivalidando ogni
volta sessione, permessi, versione approvata e catena M5. Errori di connessione,
esiti incerti, conflitti di dominio e dinieghi non vengono ripetuti. Esauriti i
tentativi, l'operazione resta negata; nessuna ricevuta parziale viene conservata.
La qualifica comprende conflitti PostgreSQL effettivi per tutte e tre le operazioni,
il conteggio esatto delle ricevute/audit committati, l'idempotenza
dell'autorizzazione e della ricevuta, e la revoca della sessione fra un aborto
iniettato e il nuovo tentativo di export o registrazione. Nessun invio esterno
avviene in queste transazioni.

Gli export Markdown/Word del dossier usano link nativi con attributo `download`: nessun prefetch o navigazione client del router deve generare ricevute di export. Il browser verifica che aprire il dossier non crei export e che il clic produca un solo file e una sola registrazione. Riferimento: https://nextjs.org/docs/app/api-reference/components/link#onnavigate .
