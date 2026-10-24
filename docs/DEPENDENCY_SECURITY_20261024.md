# Correzione dipendenze del 24 ottobre 2026

La CI del merge PR216 `73e3043d68c19353931e8f628ad3140259b87caf` ha fermato il rilascio al gate dipendenze. SQL65 non è stata applicata e la produzione resta sulla baseline PR215/schema64. Il nuovo candidato deve essere riesaminato e qualificato prima del rilascio diretto dalla baseline64, con SQL65 invariata; l'immagine del merge PR216 non è distribuibile.

- `postal-mime` 4.0.7 → 4.0.8: corregge [GHSA-f2hq-32vh-53cc](https://github.com/advisories/GHSA-f2hq-32vh-53cc), relativo al costo quadratico della decodifica di parole RFC2047 adiacenti. Restano i limiti applicativi su byte, header, profondità, parti e allegati, con rifiuto dell'intera pagina senza troncamento.
- `zod` 3.25.76 → 4.6.7: corregge [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), che richiede il controllo dei limiti delle collezioni prima della validazione degli elementi. Il codice usa l'implementazione v4, senza shim v3. Due schemi `record` dichiarano ora esplicitamente la chiave stringa, conservando i rispettivi valori e perimetri.

Il gate npm rimane invariato: client 11.16.0, ambiti runtime e completo, soglia `low`, nessuna eccezione per questi avvisi. I tre workflow PR-only per richieste Admin, incarichi tecnici e modifica selettiva lead si attivano anche quando cambiano le dipendenze. Restano PR-only: non attribuire loro run sul merge.

## Compatibilità e prove

Le prove aggiunte osservano che liste eccessive vengono respinte prima di leggere gli elementi, sia nella ricezione sia nelle versioni documentali tecniche. Le prove MIME coprono parole codificate adiacenti entro limite e rifiuto atomico oltre limite. Le fixture `ordinary-email-decision-pre-zod4.json` e `ordinary-email-inbound-pre-postal408.json` sono state prodotte dal checkout PR216 `81a7f8a960f71f20383098042de7728b1d8857df` con Zod3.25.76/postal-mime4.0.7: contengono esclusivamente dati, chiave e allegati sintetici. Verificano con le nuove librerie la firma e il MIME esatti di una decisione precedente e la ricostruzione dello stesso allegato ricevuto. Una firma tecnica sintetica storica verifica inoltre lo stesso perimetro; cambi di destinatari, autorità e scadenza restano negati.

Validazione locale iniziale: 352 prove mirate PASS, lint/typecheck PASS, audit runtime e completo senza vulnerabilità. La suite completa Windows conserva errori legati alla piattaforma; non è qualificata come PASS. La build Windows si arresta all'avvio del processo PostCSS. La CI Linux completa, i DB isolati e i browser nativi dell'esatto candidato sono obbligatori e devono essere acquisiti separatamente. Nessun dato reale utilizzato come fixture.

## Rilascio e recuperabilità

Questa correzione non introduce SQL, binding, provider o nuove funzioni. SQL65 e il prefisso64 rimangono byte per byte invariati. Prima di riprendere il rilascio servono PASS pertinente, piano e tooling aggiornati al candidato corretto, CI completa, immagine dell'esatto merge e preflight fresco. Nessun deploy derivato dal solo merge o dall'audit locale. Dopo SQL65 il recupero richiede codice compatibile65: niente down-migrate, rollback PR215, backup aggiuntivo o restore DB implicito. Esiti ambigui fermano la sequenza per riconciliazione.
