# Dashboard chiara R02

La prima schermata riprende la composizione scelta: logo FAI originale, navigazione
chiara, quattro riquadri scuri con anelli decorativi, sei aree operative, dettaglio
selezionato e priorità. I valori provengono dalle query correnti; nessun numero
dell'immagine dimostrativa è inserito nell'applicazione.

| Riquadro | Totale e filtro | Destinazione |
| --- | --- | --- |
| Lead da contattare | Lead visibili, non nel cestino, stato da_contattare | /leads?status=da_contattare |
| Pratiche attive | Pratiche tecniche visibili con grafo coerente; escluse approvate, respinte, archiviate | /technical-office/practices?dashboard=attive |
| Da revisionare | Pre-analisi in bozza_generata o da_revisionare, con cliente/progetto/società coerenti e accessibili | /preanalyses?dashboard=revisioni |
| In scadenza oggi | Attività aperte o in_lavorazione, non eliminate, nella giornata corrente | /tasks?dashboard=oggi |

La scelta aggiorna il dettaglio con un massimo di tre record, mentre il totale
resta completo. La destinazione consente di consultare gli altri record: i lead
conservano la paginazione esistente; l'elenco filtrato delle attività odierne
scorre tutti i candidati autorizzati, senza usare il limite dell'anteprima.
L'interpretazione della giornata conserva quella esistente del server.
I filtri possono essere rimossi nelle pagine di destinazione.

Il dettaglio mostra solo titolo e stato e riusa i controlli canonici del relativo
record. Non espone sintesi, importi, allegati o note riservate. Query ripetute,
sconosciute o riferite ad aree negate ricadono sulla prima area consentita.
Ogni nuova richiesta rilegge sessione e permessi: una selezione non è una concessione.
Le letture non introducono scritture, audit, approvazioni o notifiche.

Le etichette della composizione sono raccordate alle funzioni effettive:
Revisioni apre le pre-analisi; Amministrazione apre i pagamenti; Comunicazioni
apre l'area esistente. Non viene simulata una nuova coda di documenti o di invio.
Le altre destinazioni del menu e i riepiloghi operativi precedenti restano accessibili.
Il mio perimetro spiega l'ambito corrente e rimanda alle assegnazioni e ai progetti condivisi.

Gli anelli sono decorativi, non percentuali di avanzamento. Il contatore accessibile
contiene sempre il valore esatto; l'animazione visiva si arresta sullo stesso valore.
Il movimento ridotto elimina l'animazione. La scelta è disponibile da tastiera,
sposta il focus sul dettaglio e lo rende raggiungibile sullo schermo mobile.
Il logo è public/logo-fai.png, senza rigenerazione.

## Qualifica

- Test locali di selezione/limiti temporali/diniego e regressioni dei conteggi.
- Browser dei componenti reali: cifre, grandi valori, zero, contrasto forzato,
  movimento ridotto, tastiera, menu e ridimensionamento.
- CI Dashboard R02 sull'HEAD esatto: PostgreSQL con pagine di candidati non
  accessibili, coerenza dei genitori, riassegnazione e lista completa; browser
  nativo con login e registro sessioni, quattro conteggi, filtri, revoca durante
  sessione aperta, profilo negato e screenshot desktop/mobile.
- Le fixture e le schermate sono sintetiche. Le catture del componente non
  sostituiscono le prove del browser nativo e non attestano dati produttivi.

## Rilascio

App-only su schema55: nessuna modifica a Prisma, SQL, credenziali, provider,
binding email, scheduler, ricevute o regole. Riesame indipendente e CI sull'HEAD
esatto prima del merge. Qualificare il commit di merge e l'immagine, riconfermare
schema55 e runtime nel preflight e conservare il collegamento del ricevitore
email all'app effettiva secondo il piano di rilascio pertinente.
Il recupero applicativo deve restare compatibile con schema55, lifecycle,
condivisioni selettive, cursori e tentativi incerti; nessun down-migrate o restore
dedotto da questo incremento.
