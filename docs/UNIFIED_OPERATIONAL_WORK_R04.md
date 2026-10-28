# Lavoro tecnico ordinario e selettivo

Le viste Dashboard, Progetti, Pratiche, filtri di stato e I miei incarichi tecnici
usano lo stesso catalogo autorizzato. Il ruolo tecnico mantiene le responsabilità
ordinarie e aggiunge soltanto le proiezioni personali ancora valide. La scheda
ordinaria e quella limitata restano distinte. Il catalogo non crea incarichi,
prese in carico, avvii o concessioni.

La ricerca, i filtri, la paginazione e i contatori vengono calcolati sulle
proiezioni autorizzate, dopo la deduplica per tipo e identificativo. Un titolo
escluso resta senza titolo; uno stato escluso non entra nei conteggi per stato o
nel filtro delle pratiche attive. Le opzioni dei filtri non enumerano persone o
clienti estranei. Progetti e pratiche rimangono due insiemi distinti.

Il percorso ordinario ricarica il perimetro completo, comprese le esclusioni
storiche degli incarichi personali: la scadenza o revoca non riapre il vecchio
owner. Gli incarichi usano l'ammissione esistente con autorità, firma, sessione,
contesto, versione e scadenza correnti. Se la capacità personale non è disponibile,
la vista segnala il risultato parziale e conserva solo l'accesso ordinario
indipendente. Un errore non viene presentato come un contatore zero.

Limite esplicito: oltre 6.000 candidati per fonte la lettura si ferma e segnala
indisponibilità; nessun totale parziale viene presentato come completo. L'accesso
diretto mantiene i controlli preesistenti; apparire nell'elenco non concede accessi.

I documenti ordinari restano soggetti ai permessi sul documento e sul contesto.
L'incarico selettivo concede soltanto le versioni espressamente scelte, con
download distinto dall'anteprima. Contratti e pagamenti restano riservati.
Questo primo incremento R04 non modifica l'acquisizione o la concessione dei
documenti: la loro verifica completa resta un requisito distinto del mandato.

La CI dedicata usa PostgreSQL effimero e dati sintetici per responsabilità miste,
campi esclusi, revoca, chiusura, paginazione, sessione e ruoli. I browser nativi
verificano le viste, le aperture, i byte documentali ammessi e i dinieghi, con
schermate desktop e mobile. Il risultato è attestato solo sull'HEAD che esegue
la CI; nessun dato di produzione è usato come fixture.
