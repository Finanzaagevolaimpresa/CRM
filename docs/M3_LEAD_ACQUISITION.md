# M3 — Provenienza, richieste distinte e acquisizioni visibili

Il delta riusa N10/N11/N13, l'inbox commerciale N14 e il connettore VNX-02.
Non introduce migrazioni, nuovi consumer, assegnazione automatica, provider o attivazioni.
La catena corrente resta a 48 migrazioni. M2 è la dipendenza applicativa; PR160
qualifica esclusivamente il rilascio M2 e non autorizza il suo launcher a distribuire M3.

## Comportamento

- `/leads/acquisition`: solo admin autenticato, riepilogo per fonte/modulo e
  ricevute persistite, code da elaborare, errori/retry e identità ambigue.
- `/leads/{id}/requests`: richieste conservate per quel lead, con controllo
  corrente di sessione, permesso e assegnazione dentro la transazione.
- Le evidenze informative e consenso richiedono anche `privacy.evidence.read`;
  non sono esportate nel risultato destinato agli operatori privi del permesso.
- L'integrità dell'envelope N10 e del collegamento alla ricevuta viene verificata
  prima di mostrarne il contenuto. Una ricevuta incoerente richiede riconciliazione.
- Ogni nuova submission rimane distinta; il replay tecnico riusa la ricevuta.
  N13 risolve l'identità senza sovrascrivere i dati né la nuova richiesta.
- Gli ultimi cinque tentativi e il totale sono visibili. Un retry riuscito
  conserva l'errore storico ma esce dalla coda degli errori aperti.
- Il numeratore economico conta lead distinti con un cliente collegato e almeno
  un pagamento positivo, `incassato`, con data. Il denominatore conta i lead
  distinti collegati per fonte/modulo. Non è causalità pubblicitaria o ROI.
  Nessun costo viene inventato. Un lead presente in più fonti compare nei relativi
  gruppi: non sommare i gruppi per dedurre il numero globale di persone.

`campaignCode` e `adCode` sono campi opzionali dell'envelope classificato,
massimo 80 caratteri, solo codici ASCII. URL, query string, email e testo libero
sono rifiutati. La pagina sorgente continua a rifiutare query e frammenti.
I codici non costituiscono dati pubblicitari verificati dal provider.
Nessun consenso newsletter viene dedotto; le evidenze privacy originali restano distinte.
I vecchi envelope senza i due campi mantengono hash e semantica.

## Connettore 1.1.0 e ordine di rilascio

Il connettore è **FAI Secure Lead Connector / VNX-02**, non WPVibe.
La configurazione rimane disabilitata per default. I campi aggiuntivi nel
`field_map` sono opzionali e non cambiano il mapping installato automaticamente.
Prima distribuire e qualificare il CRM che accetta i campi; solo dopo qualificare
il mapping reale WPForms1265 e l'eventuale pacchetto WordPress1.1.0.
Non inserire dati personali nei campi pagina o codici pubblicitari.

Prima dell'abilitazione reale devono essere acquisite le sole evidenze pertinenti:
versione/hash del connettore installato; ID1265 e mappa dei campi effettivi;
versioni e finalità delle informative; disponibilità dei riferimenti pubblici
delle chiavi registrate; endpoint e scope del consumer già autorizzato;
ricevuta CRM e stato di un invio sintetico identificato. Non leggere/esportare
i valori delle chiavi. Il messaggio di successo WPForms non prova l'acquisizione CRM.
Le prove CI non attestano questi valori di produzione.

Il ripristino del solo CRM precedente è compatibile con il database48 invariato.
Se WordPress ha già prodotto envelope con i nuovi campi, prima del ritorno CRM
fermare la sola nuova emissione secondo il piano autorizzato e conservare la coda:
il vecchio contratto chiuso li rifiuta. Non cancellare né riscrivere ricevute o code,
non rigenerare eventi per tentare di recuperarle. Riconciliare e riprendere con un
consumer compatibile. Nessun ripristino distruttivo o retry storico è previsto.

## Qualificazione del delta

- Unit: compatibilità degli envelope, replay/conflitto/nuova submission,
  limiti dei codici, alterazioni di ricevuta e stati di acquisizione.
- PHP e confine PHP/TypeScript: mapping dei codici, corpo canonico e firma
  N12, privacy invariata; packaging1.1.0 e regressioni VNX esistenti.
- PostgreSQL effimero: due richieste della stessa persona, link manuale senza
  sovrascrittura, conversioni pagate senza doppio conteggio, errore/recupero,
  revoca/sospensione/riassegnazione/permesso corrente e paginazione.
- Chromium: navigazione admin, richieste distinte sul lead, retry visibile,
  diniego della vista globale al commerciale e del lead dopo riassegnazione.

Le nuove letture non abilitano Meta/Google Lead Ads o ChatGPT Ads. Pipeline,
esito, prossima azione e data riusano la scheda lead esistente; l'assegnazione
manuale riusa N14; un servizio acquistato prosegue tramite la pratica M2.
Autonomia Desktop, autorizzazione di messaggi M4 e attivazioni M6 restano separate.
