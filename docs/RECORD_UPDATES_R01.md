# Chi aggiornare — primo incremento CRM

Base: merge PR194 76f1a1530310f40a760e3cfe27bb335f92451569, schema52.
Lavoro in preparazione: nessuna attivazione o applicazione SQL in produzione.

Scelta Admin dei destinatari del singolo salvataggio e regole persistenti per
lead, clienti, pratiche tecniche e progetti. Primo rilascio: avvisi interni CRM.
Email da regola è un incremento successivo: nessuna approvazione di testi futuri
e nessuna equiparazione tra un avviso e un'email inviata.

Evento e lavoro da consegnare sono scritti nella stessa transazione della modifica.
Trigger SQL coprono i percorsi ordinari e l'intake; non contattano provider e non
eseguono task in background. I riepiloghi contengono solo i nomi dei campi cambiati,
mai valori, note private, margini, compensi, contenuti email o allegati.

Anteprima delle persone effettive e dei permessi correnti, poi conferma personale
nativa. I membri dei gruppi sono fissati alla conferma: appartenenza o permessi
cambiati richiedono una nuova conferma. La scelta non concede accesso.
L'originatore commerciale è suggerito solo dallo storico canonico.

Generazioni monotone dei record e utenti impediscono che revoca/riattivazione,
cestino/ripristino o riassegnazione ripristinino avvisi precedenti. Ricontrollo
di genitori, permessi, regola, scadenza e gruppi prima di metadati, contatori,
apertura e stato letto. Lettura senza scritture; segnare letto richiede un POST.

Gli avvisi di comunicazione riusano l'ammissione nativa della sorgente: versione
e hash coerenti, contesto corrente, casella/classificazione, allegati ammessi e
risposta ordinaria senza conflitti. Lock e scadenze restano validi fino al controllo
finale sul clock del DB. Un nuovo conflitto o una restrizione sopraggiunta nasconde
anche un avviso già esistente, senza registrarne la lettura.

Migration proposta: 20261017200000_record_update_notifications_v1, schema53.
Quattro tabelle e una generazione su User/Lead/Client/Project/TechnicalPractice/
ClientService. Nessuna regola, concessione, destinatario o evento inizializzato.
SQL e piano esatti saranno riesaminati prima di verificare l'autorità specifica
per la produzione. Nessun down-migrate.

Qualifica prevista sul candidato esatto: 17 prove pure di contratto, input e
proiezione; 28 casi PostgreSQL, quattro percorsi browser nativi e immagini desktop/
mobile. La catena CI verifica upgrade 52→53, errore atomico e replay, preserva
il prefisso storico e i dati sintetici. PR140 verifica gli avvisi disponibili,
le letture e le revoche sul pacchetto reale prima e dopo riavvio e ripresa dello
stesso candidato. Non rappresenta un restore del database né uso di dati reali.

La regressione F1 usa destinatari non Admin: controllo positivo ordinario,
casella riservata, COMPLAINT, SENSITIVE senza permesso, conflitto tardivo,
versione/hash non validi e allegato revocato. Il browser verifica lista, contatore,
URL diretto e POST di lettura obsoleto, con una form reale provata dal controllo
positivo. Messaggi e intake restano fixture sintetiche, senza invii o ricezioni reali.
