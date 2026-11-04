# Conservazione delle scelte nei permessi Admin

Nella scheda **Impostazioni → Utenti → Gestisci permessi**, il salvataggio dei
permessi individuali conserva anche le scelte dei selettori non modificabili.
Il server rilegge i valori correnti sotto i controlli del comando Admin: un campo
omesso dal browser perché disabilitato non equivale a scegliere **Eredita**.
Il ruolo e il limite della funzione tecnica continuano a determinare il diniego
effettivo dei contenuti riservati.

**Ripristina ereditarietà** e **Applica il profilo del ruolo** rimangono operazioni
esplicite separate. Il salvataggio ordinario non le esegue implicitamente.

Se l'ultimo audit di modifica dei permessi documenta dinieghi non modificabili
omessi e la sua situazione successiva coincide con quella corrente, la scheda
Admin presenta **Ripristina dinieghi precedenti non modificabili**. Il riepilogo
identifica la fonte e ogni passaggio da Eredita a Nega. Occorre confermare
**Ripristina dinieghi documentati**: il comando aggiunge soltanto quei dinieghi,
conserva le altre scelte e registra autore, fonte e valori prima/dopo.

Il recupero non ripristina autorizzazioni Consenti, non cambia selettori
modificabili, non modifica l'audit originale e non è disponibile per gli account
Admin o per il proprio account. Un cambiamento concorrente richiede di riaprire
la scheda. Conferma privilegiata, versione dell'account e identificativo del
comando restano obbligatori; **Verifica esito account** permette di riconciliare
un esito incerto senza ripetere la modifica.

Le prove automatiche usano soltanto account e dati sintetici. Le prove reali e
gli identificativi privati rimangono fuori dal repository.
