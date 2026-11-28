# Agenda settimanale commerciale

Calendari mostra la settimana lunedì–domenica contenente la data scelta, in Europe/Rome. Precedente, Questa settimana e Successiva conservano il referente selezionato. I confini seguono le mezzanotti locali anche nelle settimane del cambio d’ora.

La griglia legge gli stessi dati del percorso esistente: LeadAppointment del calendario selezionato, sovrapposti alla settimana, in tutti gli stati; Lead.nextActionDate per il referente assegnato, escludendo le schede eliminate. Una prenotazione BOOKED già rappresentata non duplica la prossima azione dello stesso lead. I richiami storici sono istanti senza durata inventata. Un valore senza setterNextKind è una “Prossima azione”; VIDEO e CALLBACK conservano le rispettive etichette. Lead.nextAction, note libere, Task e fonti esterne non sono interpretati come appuntamenti.

Il nome del contatto e l’eventuale azienda vengono caricati solo attraverso leadVisibilityWhere. Se ammessi, il nome apre la scheda Lead esistente, che verifica nuovamente l’accesso. L’Admin e la singola Setter configurata possono selezionare i referenti senza acquisire ulteriori diritti sulle schede. Gli altri profili restano sul proprio calendario. Gli impegni non leggibili espongono soltanto orario e stato; il profilo tecnico non riceve nomi o identificativi Lead nella proiezione HTML/RSC.

Google resta nel livello di disponibilità: soltanto intervalli free/busy, etichettati “Occupato”, senza link né titoli di eventi. Un errore non è rappresentato come calendario libero. Nessuno scope, consenso, provider, comando di prenotazione, sincronizzazione o controllo sulle sovrapposizioni è cambiato. Gli appuntamenti si fissano dalle schede.

## Diagnosi del mandato 28 novembre 2026

Alla verifica read-only della baseline PR265/a20ff2e3/schema78, non esistevano record LeadAppointment nel CRM. Il pilota aveva tre prossime azioni datate, tutte esterne all’intervallo allora visualizzato 28 novembre–4 dicembre. “Nessun appuntamento” era coerente con quei filtri: non è stato possibile confrontare un appuntamento CRM persistito perché la fonte era vuota. Un campione di prossima azione è stato verificato soltanto mediante booleani lato server, senza esportare nomi, identificativi o orari privati.

Le occupazioni Google non attestano la provenienza degli appuntamenti nominativi attesi. Non è provato che questi siano presenti esclusivamente in HighLevel o in un altro archivio. Per importarli occorrono una fonte verificabile, le regole di associazione/visibilità/deduplicazione e un mandato dedicato alle scritture. L’alternativa minima già disponibile è registrare gli appuntamenti dal pannello della scheda Lead autorizzata; la griglia li legge senza nuove integrazioni.

## Qualifica

tests/calendar-week.test.ts copre settimane, confini esclusivi, date malformate, cambio d’ora e proiezione riservata. Il workflow Commercial calendar agenda usa un database marcato sintetico, il vero server applicativo e un trasporto Google simulato che blocca ogni richiesta esterna. Prova un contatto nominativo con apertura della scheda, occupazioni anonime, settimana vuota, lettura indisponibile, navigazione, mobile e limiti di Admin/Setter/Commerciale/Tecnico; controlla anche assegnazioni e Ufficio Tecnico. Le righe di appuntamenti, calendari e lead devono restare invariate durante la consultazione.

Il mandato autorizza esclusivamente sviluppo isolato e PR in bozza. Produzione, schema, dati reali e collegamento Google restano invariati. Un eventuale rilascio richiede un mandato dedicato; l’intervento non richiede migrazioni e il rientro applicativo conserva lo stesso schema78.
