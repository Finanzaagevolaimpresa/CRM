# Integrazioni tecniche dalla coda canonica

La voce Ufficio tecnico → Integrazioni apre le richieste `INTEGRATION` già
conservate nella coda delle richieste all’Admin. La pagina di preparazione è
sostituita da ricerca, elenco, stato e accesso allo storico corrente. Il menu
essenziale dei due ruoli tecnici comprende questa destinazione, subordinata
anche al permesso corrente `technical.read`.

Nella coda generale è possibile scegliere Tutte, Documenti o Integrazioni.
La nuova ricerca riparte dalla prima pagina; i collegamenti di paginazione
conservano tipo e testo. Le parole sono cercate letteralmente: `%` e `_` non
sono caratteri jolly. Parametri ripetuti, tipi sconosciuti e pagine non valide
non vengono interpretati come accesso senza filtri.

La capacità viene verificata prima di qualsiasi filtro sul titolo, sul tipo
o sulla pagina: massimo 6.000 candidati dell’autore, oppure globali per
l’Admin personale. Oltre tale soglia l’elenco è indisponibile per tutte le
ricerche, senza risultati parziali, falsa lista vuota o suggerimenti di
paginazione. Non viene comunicato un conteggio. I collegamenti diretti
mantengono la loro ammissione corrente. È un limite esplicito di costo,
non una conclusione sul numero di richieste visibili.

Entro la capacità ogni riga necessaria viene riletta sotto il controllo
già esistente di autore, sessione, referente commerciale o incarico tecnico
corrente. Titolo e tipo si filtrano soltanto sulla riga ammessa, prima della
paginazione di 30 elementi e del lookahead. Una revoca o modifica del contesto
esclude la richiesta anche dalla vista Admin; non contribuisce alla pagina
successiva. L’Admin mantiene l’autorità personale della coda. Un tecnico
non vede la richiesta di un altro tecnico sullo stesso progetto.

Si riusano dettaglio, chiarimenti, ritiro e preparazione della bozza email.
Il tipo della richiesta non trasferisce autorizzazioni di invio. Gli stati
interni non certificano invio, consegna o lettura di un’email. Il lettore
non crea eventi, notifiche, concessioni o bozze.

Schema68 e dipendenze restano invariati; nessuna tabella, migration, coda,
cron o provider aggiunti. Le modifiche al servizio restano compatibili con
i chiamanti che non indicano il tipo. Un futuro rilascio app-only richiede
riesame, candidato e immagine esatti, piano e autorità pertinenti; non è
autorizzato da questa documentazione.

La correzione PR224-R1 rimuove il precedente filtro SQL che poteva rendere
l’esito del limite dipendente da titoli/tipi di righe negate. Le regressioni
deterministiche eseguono la funzione effettiva con dipendenze controllate
a 5.999, 6.000 e oltre 6.000 righe, per autore e Admin personale. Restano
distinte dalle prove native PostgreSQL/browser.

La qualifica prevista comprende i contratti locali, 24 prove PostgreSQL e
6 browser nella CI sintetica esistente. I nuovi casi verificano filtraggio
prima della paginazione con origini revocate, due commerciali e due tecnici,
separazione fra documenti e integrazioni, URL ambigui, cambio referente,
revoca a sessione aperta, assenza di nuovi invii e UI desktop/mobile. I
risultati vanno attribuiti soltanto all’HEAD effettivamente eseguito. La nuova
fixture di capacità contiene 6.001 richieste sintetiche con eventi, hash e
audit atomici validi; tutti i vincoli DB restano attivi. Verifica la risposta
uniforme dopo revoca, l’assenza di scritture durante le letture e la UI di
indisponibilità desktop/mobile. Non si producono fixture in produzione.

Questo incremento completa la vista delle richieste di integrazione; non
qualifica deposito su portali, rendicontazione, nuovi comandi sulle
checklist o uso di dati reali.
