# R05 M1 — responsabilità e presa in carico

L'amministratore decide le responsabilità; il destinatario registra personalmente la presa in carico. Le due registrazioni non sono equivalenti. La provenienza commerciale rimane distinta da entrambe.

## Percorso

- La voce **Le mie assegnazioni** mostra lead e pratiche assegnati personalmente, con pagine da 25 record. Le schede esistenti collegano la pagina di responsabilità.
- Sulla pratica l'admin seleziona commerciale, reparto e referente tecnico. Reparto e referente sono distinti: il solo reparto non concede accesso ai membri e non costituisce presa in carico. Il reparto è una denominazione amministrativa, non un nuovo registro di membri o una regola di accesso.
- Le scelte di referenti sono ricercabili e paginabili. Identità correnti sospese/rimosse restano riconoscibili; il servizio rifiuta la conferma di un destinatario non disponibile. La coda eccezioni precedente resta applicabile.
- La decisione richiede admin corrente, registro sessioni, step-up, versione della decisione e timestamp della pratica attesa. Responsabili canonici e decisione sono salvati nella stessa transazione serializzabile.
- Ogni destinatario usa **Confermo la presa in carico**. Il nuovo permesso `assignment.accept` è distinto dalla modifica dei dati tecnici e non basta senza responsabilità individuale, ruolo ammesso e lettura della risorsa. Admin/direzione/commerciale/consulente/backoffice hanno il permesso di ruolo; gli override possono revocarlo ai non-admin.
- Il registro sessioni, lo stato dell'utente e i permessi sono riletti sotto lock. Nessuno conferma per altri. Il reparto senza referente e una pratica chiusa o con contesto non valido non sono accettabili.
- Una nuova decisione invalida la conferma precedente, anche nella sequenza A → B → A. Un doppio invio della stessa conferma è idempotente. Una normale modifica di note non invalida la decisione; una variazione dei riferimenti della pratica sì.
- I punti esistenti di assegnazione manuale lead/pratica registrano la nuova decisione nella loro transazione. La Commercial Lead Inbox usa questo raccordo nei comandi amministrativi applicativi R05, senza cambiare prima risposta/SLA o i banchi sintetici N15. Le assegnazioni storiche senza decisione non vengono retroattivamente attribuite: l'admin le riconferma.

## Persistenza e confini

Nessuna nuova migrazione: decisioni e conferme riusano `AuditLog`, con metadati ammessi dal filtro esistente, che resta invariato. Le nuove operazioni aggiungono eventi e non riscrivono lo storico. Non è una garanzia WORM contro un amministratore del database. Gli eventi hanno autore, data, revisione e riferimenti; lo storico è paginabile a 50 eventi. Le conferme sono vincolate all'ID della specifica decisione, non al solo assegnatario.

La presa in carico non registra un contatto cliente, un'offerta accettata, un pagamento, un consenso o un invio. Non attiva regole automatiche, provider, worker, scheduler o dispatch. Gli owner del cliente non sono modificati dalle decisioni sulla singola pratica. La presenza di un'assunzione storica da parte di un account poi sospeso non riattiva l'account.

## Prove e residui

Sette prove PostgreSQL su database effimero con guard: due destinatari distinti, idempotenza, reparto senza persona, ciclo di riassegnazione, autorizzazione/sessione, concorrenza, rollback audit, lead e paginazione. Due prove browser esercitano UI/HTTP reali, step-up, tentativi di conferma altrui, revoche di assegnazione nella stessa sessione e lista oltre la prima pagina; il ramo disabled prova l'assenza di mutazioni amministrative.

Queste prove sono qualificate dalla CI del candidato; il documento non ne anticipa l'esito. Il passaggio diretto del servizio acquistato è consolidato nella stessa PR152 e documentato in `R05_M1_PURCHASED_SERVICE_HANDOFF.md`. Per quel percorso la responsabilità tecnica e l'assegnazione del servizio cambiano atomicamente; le normali pratiche non collegate a un passaggio conservano il comportamento precedente. Il recupero e la produzione restano qualificazioni successive e separate.
