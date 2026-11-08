# Aggiornamento condiviso e dati cliente

Fonte: istruzione diretta di Antonio dell'8 novembre 2026, stessa delivery Admin
Master e stesso revisore. Questo documento descrive il candidato e i suoi gate;
non attesta un rilascio produttivo o un collaudo su dati reali.

## Percorso ordinario

- Admin apre **Clienti**, **Progetti** o **Ufficio Tecnico → Pratiche tecniche**.
  Nel box **Stato d’aggiornamento in tempo reale** scrive il testo, sceglie solo
  se necessario uno stato e preme **Salva e notifica**. La conferma privilegiata
  resta quella ordinaria di 30 minuti, ripetibile nel box senza perdere la bozza.
- Il tecnico apre **I miei incarichi tecnici** o la scheda tecnica ammessa. Serve
  l'incarico nominale vigente con l'azione **Leggere dati cliente e referente e
  salvare aggiornamenti condivisi**. L'Admin la sceglie nell'incarico, una volta:
  ogni aggiornamento deriva poi i destinatari dal contesto corrente. La sola
  responsabilità di progetto o un permesso generale non equivale a questo incarico.
- Admin e commerciale referente trovano l'avviso in **Notifiche → Aggiornamenti**,
  lo aprono, usano **Apri scheda** e **Segna come letto**. La scheda condivisa non
  concede accesso a documenti, contratti, pagamenti o altri fascicoli. Il commerciale
  legge soltanto il proprio perimetro, senza un nuovo comando di modifica.

Ogni salvataggio produce un evento, una voce di storico e le consegne interne
ammesse nella stessa transazione. Nessuna email, PEC o WhatsApp. Il riepilogo
indica gli Admin effettivamente ammessi e l'eventuale commerciale corrente;
l'assenza del commerciale è esplicita e non inventa un destinatario.

## Stato, storico e ripresa

Testo obbligatorio (massimo 4.000 caratteri); prossima azione e sua scadenza al
giorno sono facoltative. Autore e data arrivano dal server; l'interfaccia mostra
l'ora Europe/Rome. **Rettifica con storico** aggiunge una voce collegata e conserva
quella originale. Non cambia implicitamente lo stato già registrato.

| Origine | Transizione esplicita ammessa | Effetti esclusi |
| --- | --- | --- |
| Cliente, solo Admin | Stato operativo separato: da avviare, in corso, in attesa del cliente/ente, attività sospesa/completata. Una correzione è ammessa fra questi valori e resta nello storico. | Lifecycle Cliente, Lead, pratiche, contratti, servizi e pagamenti. |
| Progetto | Solo stati operativi già ammessi dal contratto tecnico, senza archiviazione. Il tecnico deve avere anche `update_status` e lettura dello stato. | Stato delle singole pratiche e dati economici. |
| Pratica | Solo stati del dominio tecnico corrente, senza archiviazione. Stessa ulteriore autorizzazione nominale per il tecnico. | Altre pratiche dello stesso cliente, progetto, firma o incasso. |

Senza una scelta di stato si salva soltanto l'aggiornamento. Lo stesso identificativo
di evento appare nello storico delle tre viste collegate, dopo il ricontrollo di
ogni origine: non esistono tre copie del testo. Una pratica senza progetto conserva
solo i collegamenti reali disponibili. Le note libere precedenti restano riservate.

Le viste visibili controllano il server ogni 3 secondi; tornando su una scheda
si aggiorna subito il controllo. Il periodo non è una promessa di latenza: le prove
registrano il tempo dal clic alla comparsa dell'evento e della notifica. Le bozze
non vengono sostituite dall'aggiornamento automatico.

Le transazioni del pannello hanno un budget finito di 30 secondi anche per il
tecnico, necessario a ricontrollare le viste collegate e tutti i destinatari sul
database completo. Il browser attende fino a 35 secondi per una lettura; sessione
e incarico devono essere ancora validi al termine. Questo budget non prolunga
un'autorizzazione o una scadenza e non cambia i limiti degli altri comandi tecnici.
Una lettura ancora in corso non viene interrotta dal successivo controllo periodico.

Un cambio di contesto/versione richiede di rileggere stato e destinatari prima di
proseguire, mantenendo il testo. Revoca/scadenza tolgono la proiezione e disabilitano
il salvataggio; la bozza dell'autore rimane nella pagina. Il browser conserva in
sessionStorage soltanto l'UUID del tentativo, mai testo, contatti o credenziali.
Se manca la risposta, **Verifica esito e chiudi il tentativo** rilegge la ricevuta
oppure chiude durevolmente il tentativo non registrato prima di permettere un nuovo
comando. Doppio clic e replay dello stesso comando non creano nuovi eventi.

## Dati cliente e referente

La fonte è l'anagrafica canonica, non il testo libero: azienda collegata al progetto,
oppure aziende distinte del cliente quando non esiste quel collegamento. I referenti
mostrati sono quelli esplicitamente indicati come amministratore o contatto operativo
nelle rispettive appartenenze. Codice fiscale azienda e persona hanno etichette
diverse. Il contatto del Lead collegato mantiene la propria origine e non diventa
automaticamente amministratore o referente.

Il pannello include P.IVA, PEC, SDI, telefono/email e sedi legale/operativa distinte,
con via/piazza, civico, CAP, città e provincia. I vecchi indirizzi non strutturati
rimangono riconoscibili. Ogni dato assente mostra **Da completare**; non blocca
l'aggiornamento né la conversione del Lead. Note amministrative, dati finanziari,
contratti firmati e persone non classificate non vengono copiati nel pannello.

## Schema e qualifica

La migrazione `20261108110000_shared_operational_updates_v1` richiede il prefisso
esatto di 75 migrazioni. Aggiunge campi facoltativi e lo storico tipizzato, senza
popolare clienti, contatti, concessioni o destinatari. Il settimo comando nominale
estende il catalogo; nessun incarico esistente lo acquisisce automaticamente.

`scripts/shared-operational/qualify-migration.py` accetta soltanto un PostgreSQL 16
locale sintetico vuoto, con label, sentinel e porta loopback verificati. Qualifica
le 179 tabelle precedenti, un errore prima del COMMIT, la conservazione dei vecchi
campi, il prefisso del registro, il diniego a una seconda applicazione e un backup
con ripristino isolato delle 180 tabelle. Conserva fixture, comandi, exit, durate
e hash. I byte SQL devono rispettare il formato LF imposto da `.gitattributes`.

Le prove PostgreSQL coprono perimetri, due tecnici, concorrenza, revoca/riassegnazione,
scadenza reale, rettifiche, esiti incerti, rollback e l'interazione con le regole
RecordUpdate precedenti. Le prove browser usano login ordinario e registro nativo;
misurano le viste aperte e verificano bozza, riconferma, risposta persa e isolamento.
La CI lega queste prove al candidato esatto; non sostituisce la verifica distribuita.

Il ritorno applicativo deve usare l'immagine compatibile composta, che mantiene
schema, storico, privacy e lettori correnti e sospende i nuovi writer sia nelle
azioni server sia nel servizio. Non usare la vecchia immagine schema75 sul DB76
e non eseguire un downgrade distruttivo. La qualifica di rilascio confronta lo
storico prima/dopo ritorno e ripresa e prova i lettori con i ruoli autorizzati.

Prima dell'esecuzione produttiva restano necessari riesame sul candidato e sul
pacchetto SQL esatti, CI pertinente, backup/ripristino fresco, autorità specifica
della migrazione e piano di deploy/postflight. Nessun incarico o dato produttivo
è creato come fixture. Fascicoli Drive, video, SMTP e residui storici mantengono
i rispettivi mandati; il completamento di questo intervento non completa il CRM.
