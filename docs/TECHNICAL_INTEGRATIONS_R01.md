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

Il filtro si applica prima della scansione limitata e della paginazione.
Ogni riga viene poi riletta sotto il controllo già esistente di autore,
sessione, referente commerciale o incarico tecnico corrente. Il tipo è
ricontrollato sulla riga ammessa. Una revoca o una modifica del contesto
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

La qualifica prevista comprende i contratti locali, 23 prove PostgreSQL e
5 browser nella CI sintetica esistente. I nuovi casi verificano filtraggio
prima della paginazione con origini revocate, due commerciali e due tecnici,
separazione fra documenti e integrazioni, URL ambigui, cambio referente,
revoca a sessione aperta, assenza di nuovi invii e UI desktop/mobile. I
risultati vanno attribuiti soltanto all’HEAD effettivamente eseguito.

Questo incremento completa la vista delle richieste di integrazione; non
qualifica deposito su portali, rendicontazione, nuovi comandi sulle
checklist o uso di dati reali.
