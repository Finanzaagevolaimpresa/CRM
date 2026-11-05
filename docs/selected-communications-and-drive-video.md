# Comunicazioni selettive e video Google Drive

La lettura del testo approvato è separata da partecipazione, invio email e accesso ai fascicoli. Gli override per «Leggere comunicazioni interne» e «Video» sono espliciti per gli account tecnici; non concedono gestione, pagamenti, contratti firmati, note riservate o allegati.

Admin: Impostazioni → Utenti mostra Ereditato, Eredita/Consenti/Nega ed Effettivo. Impostazioni → Ruoli distingue anche la base ereditata dall’effetto del profilo. I selettori bloccati spiegano il limite. Una scelta di lettura non equivale alla selezione come destinatario di un contenuto.

Comunicazioni: salvare la bozza interna ordinaria, confermare la classificazione del solo testo senza allegati e approvare la versione esatta. Titolo e testo diventano leggibili soltanto ai partecipanti correnti selezionati e autorizzati. Cambi a contenuto, destinatari, identità o composizione della conversazione richiedono una nuova versione. La scadenza e la revoca agiscono anche sulla lettura diretta. Un titolo di conversazione non modifica lo stato di una pratica.

Video → Gestisci video e destinatari → Aggiungi da Google Drive permette URL, titolo, descrizione, persone ed eventuale scadenza. Il file resta nel Drive assistenza; la conferma dell’origine è una dichiarazione Admin, non una verifica API della proprietà Google. Salvare prima in bozza privata, poi visualizzare il riepilogo nominativo e confermare la pubblicazione. L’archivio revoca il riferimento; il ripristino torna in bozza.

Il link accetta soltanto file su https://drive.google.com, con forma view/preview oppure open?id. Cartelle, host alternativi, credenziali URL e redirect arbitrari vengono rifiutati. Il server non scarica il file e non applica il limite di upload locale di 20 MiB al riferimento. I file locali mantengono il proprio percorso, quota e controlli GET/HEAD/Range.

Il player offre Apri su Google Drive se Google richiede login o nega l’accesso. Il CRM non può leggere gli errori interni di un frame Google né attestare automaticamente MIME, proprietà, permessi o riproduzione. L’Admin deve verificare che il file sia il video previsto nel Drive assistenza e condividerlo su Google con le stesse persone, senza accesso pubblico. Nessun account Google, provider o condivisione viene modificato dal CRM.

Riferimenti Google: [archiviazione e riproduzione video](https://support.google.com/drive/answer/2423694?hl=it) e [permessi di condivisione](https://support.google.com/drive/answer/7166529?hl=it). Le cartelle Google possono trasmettere permessi ai file: verificare anche le autorizzazioni ereditate, senza dare accesso a cartelle con materiale riservato.

Visione, download e gestione restano distinti. Il riferimento non aggiunge download o gestione CRM. Le eventuali opzioni del player Google dipendono dal proprietario su Google. Revoca/scadenza del CRM impediscono nuove aperture e il player CRM ricontrolla ogni cinque secondi; un errore di controllo lo nasconde. Accessi diretti già concessi da Google richiedono una revoca separata su Google. Non è possibile ritirare un URL già conosciuto. Modificare i byte sotto lo stesso ID su Drive non crea una nuova versione CRM: l’audit conserva riferimenti e scelte, non una copia del file.

Le decisioni di pubblicazione scadono dopo cinque minuti anche se la conferma Admin dura trenta. Le risposte perse vengono riconciliate con lo stesso commandId; assenza verificata sotto lock produce una chiusura persistente prima di un nuovo tentativo. Le scelte restano nella schermata durante la riconferma.

Tecnico/commerciale: aprire Comunicazioni per il testo approvato o Video per la propria libreria. La conversazione non concede record o file collegati; il video non concede altri clienti. La visione non attribuisce funzioni di gestione.

Persistenza: DriveVideoReference usa revisioni tipizzate nel journal AdminRecordRevision esistente, con hash prima/dopo, autore, sessione, comando e audit nativo atomico. Nessuna migrazione o finta VideoAsset. Gli storici di profili PR252 restano leggibili attraverso il loro catalogo immutabile.

Validazione: fixture e mock di un errore Google sono distinti dalla riproduzione reale su Google e dalla ricezione email. Il collaudo produttivo richiede build distribuita qualificata e ricevute separate per salvataggio, approvazione, SMTP e caselle.

## Ordine della libreria

Libreria personale e Gestione video uniscono file locali e riferimenti Drive con lo stesso criterio, dopo i controlli di accesso e ricerca. Il campo Ordine già impostato resta prioritario. A parità di Ordine, il numero iniziale del titolo segue la sequenza numerica (2 e 02 sono equivalenti e precedono 10); i titoli senza numero seguono quelli numerati. A parità di numero, oppure tra titoli non numerati, l'ID è lo spareggio stabile, indipendente dalle date e dalla lingua del server. Il prefisso è una sequenza di cifre iniziale, eventualmente preceduta da spazi, separata dal titolo da spazio, punto, trattino, due punti o parentesi chiusa.

L'ordinamento non scrive record, versioni, destinatari, link, stati o scadenze. Una ricerca o un sottoinsieme autorizzato conserva lo stesso ordine relativo; non concede altri video. I test sintetici verificano ordine, filtri, ricerca, ricaricamento e immutabilità delle revisioni. La verifica reale riguarda la lista, non la riproduzione Google o i permessi del file esterno.
