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
- I parametri non validi vengono respinti. I risultati continuano a usare la paginazione del servizio esistente, con 20 candidati per pagina e verifica individuale dei permessi; una pagina può quindi contenere meno risultati dopo revoche o scadenze.
- Contratti, pagamenti, campi privati e documenti non selezionati restano esclusi. Nessun nuovo provider, cron, binding o migration.

## Verifica

Il workflow `technical-assignments.yml` esegue le 19 prove PostgreSQL su database effimero e le quattro prove browser native, senza fixture produttive. La nuova prova PostgreSQL qualifica la paginazione di 21 progetti, la ricerca letterale, la separazione tra persone e tipi di incarico, la revoca e l'assenza di nuove scritture durante la ricerca. Le prove preesistenti mantengono i dinieghi sui titoli non selezionati, sulle sessioni revocate e sulle scadenze.

Il browser nativo verifica ricerca positiva, filtro mantenuto tra tipi e pagine, azzeramento, incarico estraneo escluso, revoca a sessione aperta e parametri non validi. Le schermate del risultato sono raccolte a 1440 e 390 pixel, con controllo dell'assenza di overflow su mobile.

La qualifica di questo diff resta distinta da PR222. Il rilascio è app-only, su schema 68 compatibile, subordinato a CI sull'HEAD esatto, riesame indipendente pertinente, piano concreto e autorità sul nuovo candidato. Nessuna prova sintetica costituisce un incarico o un collaudo su dati reali.
