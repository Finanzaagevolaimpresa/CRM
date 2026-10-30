# Correzioni dei documenti acquisiti privatamente

Nel fascicolo cliente apri **Documenti acquisiti nel fascicolo**, poi **Correggi metadati e consulta le revisioni**. Titolo, classificazione e scadenza correnti sono distinti dai dati dell’acquisizione originale.

Modifica i campi, scrivi una motivazione e controlla il riepilogo. La conferma Admin vale trenta minuti; se scade, riconferma nello stesso modulo e poi registra la correzione. Riapri la scheda per verificare la revisione salvata. Per tornare a valori precedenti, riprendili nella bozza dalla fonte o dalla cronologia e registra una nuova correzione motivata.

Il campo scadenza mostra ore e minuti. Se non lo modifichi, oppure riprendi una revisione dalla cronologia, viene conservato l’istante esatto registrato, compresi secondi e millisecondi.

Una correzione invalida le vecchie selezioni del documento. Se necessario, scegli nuovamente persona, versione e download nel contesto di condivisione. Il documento resta privato. La riclassificazione non rimuove le tutele finanziarie o di riservatezza della fonte originaria. Il blocco, l’archivio e il cestino si gestiscono nel percorso **Blocca, archivia o ripristina il documento**; correggere i metadati non lo riattiva.

Se la risposta si interrompe, riapri lo stesso indirizzo e scegli **Verifica esito registrato**. Se non risulta un esito, puoi chiudere quel tentativo; solo dopo la chiusura prepara una nuova operazione. La chiusura impedisce che il vecchio comando venga eseguito in ritardo.

Il file e la versione acquisita sono una prova conservata: questo percorso non sostituisce i byte, non riscrive l’autore e non registra acquisizioni o prese in carico per altre persone. Una nuova fonte segue il deposito, la revisione e l’acquisizione personali già previsti. Una versione binaria amministrativa dello stesso documento acquisito non è implementata da questa fase: resta una limitazione esplicita del protocollo, distinta dalle nuove revisioni dei metadati. I documenti ordinari mantengono il proprio percorso di nuove versioni.

## Qualificazione

Le correzioni usano il journal Admin già presente a schema73; nessuna nuova migrazione. Fonte, versione, ricevuta firmata e audit originale restano identici. Il solo epoch di selezione della fonte aumenta nella stessa transazione della revisione e dell’audit amministrativi.

Le prove sintetiche devono verificare scadenza, revoca sessione, dinieghi correnti, autorità personale, classificazione finanziaria originaria e corretta, concorrenza, rollback, chiusura dei comandi, invalidazione delle selezioni anche dopo ripristino e riapertura nel browser. Queste prove non sostituiscono il collaudo reale in produzione.

La lettura verifica l’intera catena di revisioni a partire dai metadati originali: hash canonici, predecessori, continuità e unicità. Una storia incompleta o incoerente interrompe anche l’apertura del documento e la sua selezione. La paginazione della cronologia visibile non limita questa verifica. Le prove includono sei storie incoerenti ammesse dai vincoli SQL generali e una storia valida di 51 correzioni registrate dal writer ordinario, mantenendo attivi i vincoli e l’audit.
