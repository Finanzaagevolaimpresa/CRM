# Catalogo delle versioni documentali per gli incarichi tecnici — R01

Il titolare personale degli incarichi tecnici può cercare titolo e nome file e
scorrere le versioni già ammesse per la persona e il progetto/pratica scelti.
L'elenco precedente si fermava alle prime 50 versioni derivate da un catalogo
limitato a 100 documenti e 200 versioni, senza continuazione.

## Comportamento

- Pagine di 20 versioni, ricerca letterale normalizzata, anche oltre i vecchi
  limiti. La continuazione è calcolata soltanto dopo l'ammissione corrente.
- Massimo 20 versioni scelte esplicitamente; selezioni conservate tra pagine e
  ricerche. Il download resta una scelta separata, inizialmente disabilitata.
- Una ricerca non rinnova l'hash o il contesto di una versione già scelta.
  L'Admin deve rimuovere e riselezionare una versione diventata obsoleta; anteprima
  e conferma rileggono comunque gli oggetti sotto i controlli canonici.
- Le checklist collegate a una versione ammessa rimangono reperibili anche se
  quella versione si trova in un'altra pagina. Per confermare l'incarico rimane
  necessaria la scelta separata di una versione del documento collegato.

## Limiti e ammissione

Il caricamento tecnico usa un insieme completo e limitato a **256 documenti e
256 versioni candidate per cliente**, prima dei filtri di ricerca e paginazione.
Il limite sulle versioni include tutte le versioni dei documenti candidati, anche
quelle non ammissibili. La prima eccedenza interrompe l'intero catalogo: nessuna
pagina parziale o conteggio indistinguibile da un elenco completo. La revoca
dell'incarico esistente rimane indipendente. I cataloghi cliente/pratica ordinari
conservano i limiti e il comportamento precedenti.

La selezione tecnica riusa le verifiche canoniche per autorità personale, sessione,
destinatario corrente, contesto, lifecycle, perimetri selettivi indipendenti,
riservatezza, riferimenti finanziari, acquisizioni private e versione/checksum.
I controlli sono raggruppati in lotti di massimo 20; un lotto con dinieghi viene
suddiviso conservando gli stessi controlli. Errori di storage o serializzazione
non diventano falsi elenchi vuoti. La scadenza minima delle ammissioni viene
ricontrollata prima della restituzione, incluse le versioni fuori pagina.

Nessun contenuto, percorso storage, documento non ammesso o numero di righe
escluse viene restituito dall'azione di ricerca. La ricerca non assegna persone,
non scrive audit, non scarica file e non richiede un nuovo step-up. Anteprima e
conferma dell'incarico mantengono la decisione personale e il consumo già esistenti.

## Qualifica prevista

Prove pure su ricerca, pagine, conservazione delle scelte, limiti del caricamento
condiviso e separazione fra diniego e errore. Prove PostgreSQL e browser nativo
esclusivamente in CI isolata: oltre 100 documenti/200 versioni, confine 256/257,
documenti esclusi, mutazioni concorrenti, selezione obsoleta, byte esatti,
download separato, versioni future e altri tecnici/commerciali, revoca indipendente.
Restano le regressioni del catalogo attività, dei documenti selettivi, delle
acquisizioni private e delle comunicazioni. Nessun dato reale usato come fixture.

## Dipendenza e rilascio

La preparazione nasce dal candidato PR225 `27b194ee3232a79e56d84bbaf26a3dbc16e3d20a`.
La sua base deve essere riconciliata con il main effettivamente integrato prima
del pacchetto finale. Nessuna migration, dipendenza, nuovo binding, provider o
attivazione produttiva è contenuta nel delta. Schema68 preservato.
CI verde e riesame pertinente non costituiscono un deploy: occorrono il piano
app-only concreto, l'autorità pertinente, la qualifica dell'esatto merge/immagine
e il preflight fresco. Nessun down-migrate o rollback automatico.
