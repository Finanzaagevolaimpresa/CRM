# Percorso manuale N14

L’Admin apre il lead e «Apri coda e assegnazione del referente». La coda spiega quando serve «Conferma identità per assegnare». Dopo la conferma personale di cinque minuti si torna alla coda; una scelta esplicita del commerciale attivo precede «Assegna».

Il referente vede solo i propri lead, registra separatamente la presa in carico nella pagina Responsabilità e la prima risposta effettiva nella coda o nella scheda. La conversione rimane riservata al referente e subordinata alla risposta. Nessun GET assegna o risponde; autorizzazione, sessione, versione corrente e step-up restano controllati dal server.

Il filtro per un singolo lead resta congiunto al perimetro corrente, allo stato della coda e all’esclusione del cestino. Una conferma identità può ritornare soltanto alla destinazione interna esplicitamente ammessa, senza redirect arbitrari.

## Cliente già acquisito prima del CRM

Questo incremento rende utilizzabile l’assegnazione esistente e non ricostruisce retroattivamente gli eventi. L’azione corrente di prima risposta registra l’ora del comando nel database: non va usata per attestare come nuovo un contatto passato. Data dell’evento effettivo, fonte/prova e data di registrazione devono essere conservate separatamente da un successivo incremento del modello N14, con controlli del referente, evidenza verificabile, audit e idempotenza. Non modificare firstResponseAt o SLA per superare il gate; nessun cliente o pratica viene creato da questa guida.

Le prove usano soltanto dati isolati. Nessuna anagrafica o identificativo di un caso reale è incluso nel diff.
