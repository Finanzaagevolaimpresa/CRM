# Accessi selettivi ai lead — primo incremento

## Comportamento

L'utente Admin personalmente abilitato apre **Condividi accesso selettivo** dalla scheda di un lead operativo. Sceglie una persona esistente, uno o più campi e una eventuale scadenza. L'anteprima mostra i valori effettivi, la persona con indirizzo e ruolo correnti e l'effetto sui suoi diritti precedenti. La conferma richiede la verifica personale recente della password e la selezione esplicita della casella di conferma.

Il destinatario apre **Lead condivisi con me** nell'area Lead. La pagina condivisa contiene solo i campi scelti. L'elenco usa etichette generiche: neppure il nome dell'azienda viene esposto se escluso dalla selezione.

Campi ammessi: nome, cognome, azienda, referente, email, telefono, regione, provincia, città, interesse, stato, priorità. La selezione è di sola lettura. Documenti, note, offerte, dati del cliente convertito, modifica e caricamento non sono inclusi nella proiezione. I diritti indipendenti sul cliente convertito restano distinti: questa scelta non li concede né li rinnova.

Una selezione è un limite anche per un destinatario Admin che prima vedeva il lead completo. Le pagine ordinarie e le operazioni sul lead vengono escluse. Revoca, scadenza o invalidazione non ripristinano automaticamente l'accesso ordinario. Il gestore può sostituire la selezione con una nuova decisione sullo stato corrente. Le copie già ottenute dal destinatario non possono essere recuperate.

## Autorità e versioni

`SelectiveLeadAuthority` è distinta dalle autorità progetti ed email. La migration crea strutture vuote; una visita o anteprima non abilita nessuno. Serve un atto specifico sul profilo personale effettivo prima di usare la funzione in produzione. Il solo ruolo Admin non attribuisce tale autorità. Non si può condividere con sé stessi.

Il comando contiene UUID, lead, destinatario, revisione attesa, campi e scadenza. L'anteprima, valida cinque minuti, è firmata su questi valori e sul contesto corrente: sessione, persona, binding, generazioni, stato completo del lead e selezione precedente. Una modifica del contenuto o della persona dopo l'anteprima impone di rifarla.

I grant sono firmati separatamente. Una generazione dedicata dell'utente (`selectiveLeadEpoch`) cambia con ruolo, stato, identità o permessi, anche se il cambiamento viene annullato successivamente. Cambio assegnatario/cliente e lifecycle del lead usano la generazione del record. Una diversa selezione aggiorna la generazione delle notifiche (`recordUpdateEpoch`) senza invalidare i grant su lead indipendenti.

## Controlli server

| Famiglia | Controllo |
| --- | --- |
| Lead, ricerca, contatori, liste, inbox, assegnazioni | Esclusione per destinatario prima della paginazione, relazione persistita riletta anche con snapshot della sessione precedente |
| URL diretti, modifica e conversione | Attore e sessione autorevoli, lock utente e lead, controllo di perimetro dentro la transazione |
| Offerte ed esportazione | Rifiuto del lead escluso prima dei privilegi ordinari; nessun bypass tramite cliente o creatore dell'offerta |
| N14 e responsabilità | Lock del destinatario e controllo della selezione prima del lock/mutazione del lead; nessuna modifica retroattiva di SLA o risposta |
| Acquisizione e duplicati | Coda e candidati filtrati; replay e riapertura non espongono lead selezionati; identità nascosta non ricreata con intake manuale |
| Readiness, comunicazioni, aggiornamenti | Contesto corrente, esclusione del lead prima dell'accesso al progetto; vecchi destinatari e ammissioni riletti |
| Audit | Esclusione degli identificativi di lead, grant, comandi, offerte, inbox, intake, duplicati e contesti collegati |
| Pagina condivisa | Firma, autorità, sessione, generazioni, scadenza, revisione immutabile, comando, ricevuta e audit verificati; restituzione della sola proiezione |

Ordine dei lock della decisione: chiave, directory condivisa, identità lead, autorità, utenti ordinati/sessione, lead. La validità di sessione e step-up viene verificata anche dopo le attese. Le operazioni che concorrono sul lead usano le barriere esistenti. Un conflitto abortisce; non viene trasformato in approvazione.

Grant, comando, revisione e audit minimizzato sono atomici. Trigger differiti richiedono il collegamento e la stessa transazione. Comandi e revisioni sono immutabili; la storia e le identità dei grant non sono eliminabili. L'audit contiene solo revisione, operazione e numero di campi, senza valori o indirizzi.

Un UUID già consumato può restituire la stessa ricevuta solo per la stessa richiesta e sessione; non esegue un'altra mutazione. Il browser registra l'UUID nell'URL prima dell'invio. Se perde la risposta, blocca i nuovi invii e consente una riconciliazione in sola lettura o il ricaricamento. Una ricevuta storica è distinta dall'accesso attualmente valido.

## Schema e recupero

Migration `20261018140000_selective_lead_read_v1`, schema 55 → 56, baseline `1e463b01dd22f09aab73a35fac7203598dc7c044`. SHA256 SQL `29053ccb2bb289b24f34b18db9181019518e6dd39e83e7fac7dc49a5dbdde5d4`. Aggiunge la generazione utente e quattro tabelle vuote con otto FK restrittive. Nessuna autorità o concessione reale viene creata dalla migration. Nessun nuovo provider o scheduler.

La CI verifica fault prima del commit, conservazione delle righe preesistenti e dei primi 55 checksum, tabella autorità vuota, replay rifiutato e compatibilità del datamodel. I contatori dei workflow correnti passano a 56; i profili storici conservano le proprie versioni.

PR140 deve qualificare l'immagine esatta del candidato e il suo riavvio compatibile con schema56: campi selezionati consultabili, revoche ancora efficaci, storia/comandi/audit/generazioni invariati. Non è ammesso tornare a un binario che ignora i perimetri o fare down-migrate. Il rilascio richiede il piano operativo esatto, riesame indipendente e l'autorità specifica su SQL e binding; questo documento non è un'autorizzazione produttiva.

## Prove previste sul candidato

- Unit: input chiuso, canonizzazione, firme, anteprima/versioni, generazioni e proiezione.
- PostgreSQL: autorità distinta, denieghi, revoche/scadenze, sessioni aperte, concorrenza, doppio comando, audit atomico, risposta persa, cambio ruolo e ritorno, modifica in attesa del lock.
- Browser nativo sintetico: anteprima e conferma reali, due campi soltanto, percorsi indiretti, revoca nella sessione aperta, comando con risposta persa, sessione revocata, screenshot desktop/mobile.
- Migrazione e recupero: dati esclusivamente sintetici in CI; build e invarianti dei percorsi esistenti.

Gli esiti effettivi sono legati all'HEAD e riportati nella PR. Non sono prove d'uso su dati reali. Clienti, pratiche, caricamenti/modifiche e i tre flussi di comunicazione dell'ordine restano incrementi successivi.
