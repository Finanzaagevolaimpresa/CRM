# Archivio documentale: confronto e proposta senza migrazione

La valutazione richiesta non autorizza upload, cancellazioni, migrazioni massive, nuove connessioni provider o modifica delle credenziali. L’archivio attuale deve continuare a funzionare. I 5 TB di Drive sono una capacità riferita dal titolare, non quota libera verificata. Non è stato misurato qui il consumo o lo spazio disponibile del VPS.

| Soluzione | Utilizzo utile | Limite da rispettare |
| --- | --- | --- |
| Archivio CRM attuale | Indice, classificazione, contesto cliente/progetto/pratica, destinatari, versioni, audit e file privati del backend | Il provider implementato è locale al backend; percorso e disponibilità dipendono dal deployment |
| Fascicolo organizzativo | Struttura di lavoro e responsabilità per raccolta/conservazione | Una cartella organizzata non applica da sola i grant e la revoca del CRM |
| Cartella locale ASUS | Lavoro locale e copie gestite dal titolare | Il VPS non può leggere automaticamente un percorso C: del PC; disponibilità e backup dipendono dal PC |
| Drive privato | Potenziale spazio per contenuti documentali e versioni | Richiede un connettore progettato e autorizzato; Drive Desktop non collega automaticamente il backend CRM |

Nel codice corrente il provider locale usa un’area privata del filesystem del backend. Il limite applicativo è 25 MiB per singolo file e 20 file per operazione: non rappresenta una misura della capacità totale o dello spazio libero. Le versioni, i collegamenti e le scelte di download sono dati applicativi, non deducibili dall’esistenza di un file sul disco.

La proposta è conservare nel CRM l’autorità su indice, classificazione, permessi, audit e selezione delle versioni. Un futuro connettore potrebbe conservare i contenuti su Drive privato, registrando identificativi stabili di file e revisione, checksum e stato. Ogni apertura dovrebbe passare dal backend, che ricontrolla utente, grant, versione, revoca e scadenza. Il riferimento esterno non sarebbe un link pubblico e non autorizzerebbe la condivisione diretta di un’intera cartella con i tecnici.

Drive applica permessi propri e può ereditarli dalle cartelle. Un permesso ereditato non si revoca semplicemente sul singolo figlio; eventuali concessioni dirette vanno considerate separatamente. Pertanto l’ACL Drive deve restare coerente con il percorso controllato, senza vie parallele verso pagamenti, contratti firmati e note. [Documentazione ufficiale sui permessi](https://developers.google.com/workspace/drive/api/guides/manage-sharing).

Fonti ufficiali rilette il 01/11/2026. Le revisioni binarie richiedono una politica esplicita di conservazione: quelle non conservate possono essere eliminate automaticamente e il flag keepForever ha limiti. Per le revisioni binarie da conservare e scaricare va prevista la conservazione esplicita, entro i limiti del provider; un oggetto immutabile distinto per ogni versione è un’alternativa da qualificare. Il CRM non dovrebbe considerare recuperabile una versione soltanto perché conosce il suo ID. [Revisioni](https://developers.google.com/workspace/drive/api/guides/manage-revisions), [download di file e revisioni](https://developers.google.com/workspace/drive/api/guides/manage-downloads).

Il backup/ripristino dovrebbe qualificare insieme DB, indice delle versioni e byte esatti, includendo hash, accessi, revoca e indisponibilità del provider. Prima di un’eventuale decisione servono quota/capacità effettiva, proprietario dell’archivio, politica di conservazione, modalità del connettore e prova di ripristino su dati sintetici. Non sono prerequisiti per tenere operativo l’archivio locale attuale.

La sincronizzazione o lo streaming di Drive Desktop riguarda il dispositivo che lo esegue; non sostituisce queste verifiche del backend. [Drive Desktop: streaming e mirroring](https://support.google.com/drive/answer/13401938).
