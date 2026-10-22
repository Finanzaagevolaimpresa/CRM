# Avanzamento commerciale dopo il passaggio tecnico

Primo incremento del mandato FAI-CRM-PERIMETRI-RUOLI-20261022-R01, separato dalla modifica selettiva lead PR211. Riusa `/progress` e conserva il percorso esistente di avvio del servizio. Aggiunge una sezione di avanzamento tecnico con stato codificato, scadenza e data del prossimo aggiornamento. Il relativo endpoint GET è `/api/commercial-progress` e non produce scritture.

La proiezione richiede sessione registry corrente, ruolo Commerciale attivo, `client.read`, riferimento commerciale coerente nel cliente e nella pratica, genitori attivi e nessuna restrizione selettiva. Se i riferimenti commerciali divergono, non viene inferita una concessione: serve la riconciliazione amministrativa. Cambiare tecnico non cambia il riferimento commerciale. La query seleziona soltanto record pertinenti, applica la ricerca all'interno del perimetro e pagina 50 pratiche per volta. I controlli di contesto e il DTO chiuso sono ripetuti prima della risposta. Sessioni, diritti e perimetri vengono riletti sotto lock; i conflitti non producono risultati da una cache precedente.

Non vengono restituiti titolo libero della pratica, note interne, testo libero di comunicazioni, contratti, pagamenti, ID di progetto/servizio o documenti. I contesti comunicazione e le versioni documentali restano soggetti ai loro flussi distinti. Nessuna nuova migration, autorità, concessione, notifica o invio è richiesto da questa proiezione.

Qualifica prevista: policy pura; PostgreSQL su database effimero identificato dal sentinel; browser nativo con due commerciali e due tecnici, ricerca/API, cambio tecnico, cambio commerciale, sessione revocata, desktop/mobile. Le prove locali non attestano il browser, il database o la produzione. Il branch è riconciliato con il merge PR211 `42e0577ed7fd8b541812940fd5193a1f499657b5`, schema63. I risultati del precedente candidato su schema62 restano storici: la CI va completata sull'HEAD riconciliato prima del riesame.

## Residui espliciti del mandato

Questo incremento non chiude il flusso completo. Restano il rafforzamento uniforme delle viste ordinarie e dei menu per ruolo, le assegnazioni operative tecniche multiple, l'uso positivo dei documenti tecnici autorizzati, le richieste interne e la loro trasformazione in email personalmente approvate, e le funzioni tecniche oggi segnaposto. La prova completa lead→cliente→più tecnici→avanzamento→richiesta→invio simulato resta da realizzare. Non modificare account reali o il ruolo di Alina per il collaudo.
