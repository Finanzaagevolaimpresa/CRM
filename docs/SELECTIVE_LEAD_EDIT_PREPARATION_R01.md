# Modifica selettiva dei lead

PR211 resta una bozza non distribuita, basata sul merge PR210
d6a5a3d14a9b3a1ade0d33e6b156ad71da5d9b0f (schema62).
La SQL è ancora esterna alla catena Prisma e il binding personale
lead-edit non è stato creato in produzione.

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

Il nuovo workflow prepara un database PostgreSQL effimero con schema62, verifica
rollback della SQL bozza e autorità inizialmente vuota. In job separati esegue
le 16 prove dei servizi e tre scenari browser nativi: decisione personale,
modifica precisa, revoca con form aperto, risposte perse di decisione e modifica,
sessione revocata, dinieghi diretti, controlli e screenshot desktop/mobile.
Non usa dati o credenziali reali e non attiva provider.

Restano prima della revisione e del rilascio:
- acquisire le nuove prove sull'HEAD esatto e ispezionare gli screenshot;
- integrare SQL e modelli nella catena Prisma con qualifica della migrazione;
- preparare il piano preciso di rilascio, recuperabilità e binding personale;
- ottenere PASS pertinente e l'autorizzazione specifica alle nuove SQL/binding.

La sola compilazione o una PR verde non completano questi passaggi.