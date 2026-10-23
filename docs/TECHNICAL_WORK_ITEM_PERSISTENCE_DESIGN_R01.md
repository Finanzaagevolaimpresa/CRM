# Collegamenti e lavoro tecnico su checklist e attività

Disegno locale sulla dipendenza PR216, non SQL eseguibile o implementazione attiva. L'inventario `technical-work-item-source-inventory-r01.json` elenca i riferimenti del sorgente verificato; non dimostra da solo la chiusura di tutti gli accessi.

## Persistenza proposta

Il record canonico resta `DocumentChecklistItem` oppure `Task`. Occorre conservare un legame esplicito al singolo `Project` o `TechnicalPractice`, senza trasferire automaticamente record del cliente o del servizio. Il legame non è una concessione. La successiva decisione personale di incarico deve scegliere elemento, campi, operazioni e scadenza per il singolo tecnico.

| Oggetto | Vincolo necessario |
| --- | --- |
| Legame elemento/target | Un elemento e un target esatti; FK RESTRICT; nessuna cascata; stato e revisione; decisione personale conservata e audit atomico. Un cambio di contesto rende inutilizzabile il legame precedente. |
| Versione elemento | Revisione monotona anche per scritture ordinarie; modifiche a relazioni, documento e lifecycle invalidano l'anteprima. Nessun backfill che conceda accesso ai record preesistenti. |
| Selezione nell'incarico | Riferimento alla revisione del legame e ai campi; niente elementi futuri impliciti. Le decisioni precedenti restano verificabili ma non ricevono nuove operazioni. |
| Comando tecnico | UUID, attore/sessione, incarico/revisione, legame/revisione, versione attesa dell'elemento, digest della proposta e ricevuta minimizzata, tutti nello stesso commit del cambiamento e dell'audit. |
| Documento della checklist | Versione/file/hash e ammissione documentale separati. La lettura della voce non rivela titolo, metadati o contenuto di un file non selezionato. |

Una migration candidata dovrà essere verificata contro la baseline effettivamente integrata di PR216. Questo documento non assegna un numero schema né autorizza SQL, binding, concessioni o popolamento produttivo.

## Lettura e mutazione

La transazione deve riusare l'ammissione personale, i lock ordinati e il giornale degli incarichi. Prima di proiettare una riga si verificano origine, destinatario, contesto, lifecycle, scadenza, revoca, selezione dell'elemento e limiti finanziari. La mutazione confronta nuovamente tutti questi fatti dopo l'anteprima, incluso l'istante finale. Il lock del solo record attività non sostituisce quelli sul contesto e sull'incarico.

Le funzioni ordinarie `canViewTask` e `canViewChecklistItem` non conoscono un nuovo legame o una selezione di campi: non possono diventare il fallback per un tecnico su un elemento vincolato. La chiusura deve comprendere `read-access`, `write-access`, `actions`, notifiche, dashboard, fascicolo, readiness, dossier e report. I percorsi personali devono restituire una proiezione limitata, mai una riga completa passata a un componente e soltanto nascosta graficamente. Admin/Amministrazione conservano le funzioni pertinenti; il referente commerciale riceve solo l'avanzamento già ammesso, senza ereditare note o checklist tecniche.

Le transizioni di stato hanno un comando distinto dalle modifiche di testo o scadenza. `richiesto` non può attestare una comunicazione mai inviata; `ricevuto` e `validato` richiedono il documento e la versione pertinenti, con ammissione corrente. Un'attività completata deve conservare autore, istante e ricevuta; un annullamento non elimina lo storico. Non si crea una notifica o un invio come effetto implicito del cambio di stato.

## Prove che sbloccano l'integrazione

1. Due tecnici sul medesimo target con elementi o campi differenti; due commerciali separati. Nessuna propagazione a un'altra pratica dello stesso cliente/progetto/servizio.
2. Anteprima seguita da modifica ordinaria, revoca, scadenza, riassegnazione, cestino o cambio versione documento: conferma negata senza scritture parziali.
3. Doppio clic e stessa richiesta ripetuta: una sola mutazione/ricevuta; UUID riusato con contenuto differente negato. Risposta persa: riconciliazione della ricevuta, mai retry con nuovo comando.
4. Errore tardivo su audit o relazione: rollback completo. Nessuna lettura scrive e nessun polling crea oggetti mancanti.
5. URL/API, ricerca, conteggi, notifiche, report/esportazioni, metadati, anteprima e download: campi e documenti estranei assenti, documenti tecnici selezionati realmente utilizzabili.
6. Browser nativo desktop/mobile con valori e stati persistiti, non soltanto liste vuote. Regressioni degli incarichi, delle richieste Admin, delle email e delle condivisioni correnti.

Restano da implementare persistenza, nuove decisioni personali, servizi, chiusura delle vie ordinarie e UI. Le 18 prove pure della preparazione verificano solo contratti di selezione e contesto.
