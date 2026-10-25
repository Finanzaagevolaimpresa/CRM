# Ricerca negli incarichi tecnici — R01

La pagina **I miei incarichi tecnici** permette di cercare un progetto o una pratica per titolo. Il campo usa la ricerca già presente nel servizio degli incarichi personali; non introduce una ricerca nel fascicolo generale del cliente.

## Percorso

1. Aprire **I miei incarichi tecnici** e scegliere Progetti o Pratiche.
2. Inserire parte del titolo in **Cerca per titolo** e premere **Cerca incarichi**.
3. Aprire un risultato autorizzato, oppure cambiare tipo di incarico mantenendo il filtro.
4. **Precedenti** e **Successivi** conservano il filtro. Una nuova ricerca o il cambio di tipo ripartono dalla prima pagina. **Azzera ricerca** mantiene il tipo selezionato.

La ricerca ignora le differenze tra maiuscole e minuscole e gli spazi iniziali/finali, accetta al massimo 200 caratteri e tratta i caratteri speciali come testo. Il titolo deve essere incluso nel perimetro personale confermato dall'Admin. Una ricerca senza corrispondenze non rivela il titolo degli incarichi esclusi.

## Confini preservati

- Il servizio esistente rilegge sessione, ruolo, permessi, incarico, scadenza, revoca, contesto e versioni prima di restituire un risultato. Anche l'apertura del risultato ripete i controlli.
- Progetti e pratiche hanno incarichi distinti. Il referente commerciale, la titolarità tecnica precedente o il collegamento al cliente non sostituiscono un incarico personale corrente.
- La ricerca non crea concessioni, comandi di lavoro, ricevute o audit. Non modifica dati, stato, assegnazioni o documenti.
- I parametri non validi vengono respinti. Le pagine contengono fino a 20 risultati ammessi: revoche, scadenze e contesti non più validi vengono esclusi prima di calcolare la posizione nella pagina. **Successivi** richiede un ulteriore risultato ammesso, compreso il titolo effettivamente leggibile. Titoli modificati dopo revoca non contribuiscono alla ricerca o ai collegamenti.
- Il lettore considera un massimo di 6.000 candidature personali per tipo, indipendentemente dalla query; oltre questo limite restituisce indisponibilità per tutte le query, senza una lista parziale o una falsa ultima pagina. Il limite non dipende dai titoli cercati. Le scadenze dei risultati usati per pagina e continuazione vengono ricontrollate prima della risposta; le transazioni restano soggette ai normali limiti di durata.
- Contratti, pagamenti, campi privati e documenti non selezionati restano esclusi. Nessun nuovo provider, cron, binding o migration.

## Verifica

Il workflow `technical-assignments.yml` esegue 21 prove PostgreSQL su database effimero e cinque prove browser native, senza fixture produttive. Le prove PostgreSQL qualificano pagine di 20+1 risultati ammessi, almeno 21 titoli tutti revocati e cambiati dopo la revoca, e una finestra iniziale negata per revoca/scadenza/contesto seguita da 21 risultati validi. Verificano inoltre ricerca letterale, separazione tra persone e tipi e assenza di nuove scritture durante la ricerca. Le prove preesistenti mantengono i dinieghi sui titoli non selezionati, sulle sessioni revocate e sulle scadenze.

Il browser nativo verifica ricerca positiva, filtro mantenuto tra tipi e pagine, azzeramento, incarico estraneo escluso e parametri non validi. Nella stessa sessione passa da 21 incarichi validi a tutti revocati, controlla i titoli modificati dopo revoca e la scomparsa di **Successivi**, poi verifica una scadenza senza nuovo login. Le schermate del risultato e del diniego sono raccolte a 1440 e 390 pixel, con controllo dell'assenza di overflow su mobile.

La qualifica di questo diff resta distinta da PR222. Il rilascio è app-only, su schema 68 compatibile, subordinato a CI sull'HEAD esatto, riesame indipendente pertinente, piano concreto e autorità sul nuovo candidato. Nessuna prova sintetica costituisce un incarico o un collaudo su dati reali.
