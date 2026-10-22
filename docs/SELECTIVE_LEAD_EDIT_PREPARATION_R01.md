# Modifica selettiva dei lead

PR211 resta una bozza non distribuita, basata sul merge PR210
d6a5a3d14a9b3a1ade0d33e6b156ad71da5d9b0f (schema62).
La nuova migration candidata `20261022110000_selective_lead_edit_v1` porta
la catena Prisma da 62 a 63. Il binding personale lead-edit non è stato
creato in produzione. La SQL bozza conservata in docs è soltanto storica.

## Comportamento del candidato

L'Admin personalmente abilitato sceglie i campi modificabili fra quelli già
condivisi con il destinatario: interesse e priorità. La scelta ha anteprima,
conferma personale con step-up, scadenza e revoca. Richiede un binding distinto
dalla lettura, riferito alla stessa persona autorizzata; nessun altro Admin lo
eredita dal ruolo.

La capacità conserva ID, revisione e firma della precisa concessione di lettura.
Una lettura sostituita, revocata o scaduta interrompe la modifica, come il cestino,
la conversione del lead, una sessione revocata o un diniego corrente. Il ripristino
non rinnova i permessi. La scadenza non supera quella della lettura.

Il destinatario apre «Modifica i campi abilitati» dal lead condiviso, cambia i
soli valori consentiti e conferma un riepilogo prima/dopo. Non accede al form
commerciale ordinario. Stato, assegnazioni, recapiti, note, documenti, contratti,
pagamenti e consensi restano esclusi. Inbox e SLA non vengono modificati.

Le azioni rileggono sessione, autorità, permessi, generazioni e versioni sotto
lock serializzabili. Anteprima e conferma hanno scopi di firma distinti. La
conferma salva cambiamento, comando, audit minimizzato e ricevuta nella stessa
transazione. I vincoli differiti vengono verificati prima che il callback possa
restituire una ricevuta. Il replay del medesimo comando non ripete la modifica.

In caso di risposta persa, il browser conserva nell'URL solo il riferimento
opaco del comando. Dopo il ricaricamento propone la verifica dell'esito e blocca
un nuovo salvataggio. La ricevuta non contiene i valori del lead; la lettura della
ricevuta richiede ancora identità, sessione e autorizzazioni correnti. L'assenza
della ricevuta non viene interpretata come esito negativo definitivo.

Percorsi aggiunti nel candidato:
- /leads/[id]/sharing/editing: gestione personale della modifica;
- /leads/[id]/edit-selected: modulo ristretto del destinatario;
- collegamenti dalle pagine di condivisione già esistenti, visibili solo
  quando il controllo corrente ammette l'operazione.

## Qualifica e limiti

Il commit remoto 0de8a9f41eca94bd85d6f4e18b4402fc61dbf50e ha superato
16 prove PostgreSQL, zero skip/fallimenti, e 28 workflow CI
(run dedicato39749026434/job119724612072).
Queste prove riguardano i servizi, la SQL bozza e il precedente modulo non
collegato; non vengono attribuite al successivo delta di route, action e
interfaccia Admin.

Il commit 1f970a12bf50896cdc1426544caac8fa8ab148fe ha superato 16 prove DB
e tre scenari browser nativi sulla SQL bozza, run39755587556. Le quattro
schermate desktop/mobile sono state ispezionate: nessun overflow e selezioni
coerenti con l'anteprima dopo la correzione del reset automatico dei form.
Queste prove non vengono attribuite alla successiva integrazione schema63.

Il workflow corrente prepara un database PostgreSQL effimero con schema62, verifica
rollback della nuova migration e autorità inizialmente vuota. In job separati esegue
le 16 prove dei servizi e tre scenari browser nativi: decisione personale,
modifica precisa, revoca con form aperto, risposte perse di decisione e modifica,
sessione revocata, dinieghi diretti, controlli e screenshot desktop/mobile.
Non usa dati o credenziali reali e non attiva provider.

La qualifica dell'immagine candidata prepara anche due permessi di modifica
sintetici, uno ancora valido e uno revocato, e un solo aggiornamento registrato.
Prima e dopo riavvio e ripresa controlla valori salvati, anteprima senza scritture,
diniego della modifica revocata e della ricevuta da un'altra sessione. Confronta
tutte le cinque tabelle nuove, audit, lead, inbox e SLA per conservarne lo stato.
Questa nuova prova richiede ancora l'esecuzione CI sul candidato schema63.

Restano prima della revisione e del rilascio:
- acquisire le prove sull'HEAD che integra schema63;
- qualificare la migrazione e la recuperabilità dei permessi di modifica;
- preparare il piano preciso di rilascio, recuperabilità e binding personale;
- ottenere PASS pertinente e l'autorizzazione specifica alle nuove SQL/binding.

La sola compilazione o una PR verde non completano questi passaggi.
