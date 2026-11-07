# Fascicoli Drive: collegamenti selettivi ai clienti

Fonte funzionale: mandato FAI-CRM-FASCICOLI-DRIVE-20261107-R01. Questa documentazione descrive il candidato; il rilascio e il collaudo reale sono attestati separatamente nella consegna privata. Non contiene associazioni, URL o dati di clienti reali.

## Percorso Admin

1. In **Impostazioni → Utenti**, apri la persona e imposta **Aprire Fascicoli Drive → Consenti**. Questo abilita soltanto la sezione, senza concedere cartelle. **Gestire Fascicoli Drive** resta riservato all’Admin.
2. Apri **Fascicoli Drive**, subito sotto **Video**, quindi **Gestisci collegamenti e accessi → Collega cartella Drive**. Oppure entra nel cliente e usa **File condivisi → Collega cartella Drive a questo cliente**.
3. Seleziona un cliente già esistente, titolo, URL della cartella e persone identificate anche dall’email. Non creare un altro cliente per sistemare un’associazione incerta. Non sono ammessi link a file o ad altri siti.
4. Salva la **bozza privata**, controlla il riepilogo, conferma e riapri la scheda persistita. La bozza non è visibile ai destinatari. Poi usa **Attiva per le persone scelte** con eventuale scadenza. La sostituzione di URL o cliente passa prima da una nuova bozza privata, ritirando la pubblicazione precedente.
5. Per revocare una cartella a una persona, toglila dalla selezione e conferma una nuova attivazione. Per ritirare tutto il riferimento usa **Disabilita il riferimento CRM**. Per sospendere la sezione a un account, imposta il suo permesso su **Nega**; la riabilitazione richiede una nuova selezione corrente delle cartelle. Ogni operazione conserva autore, comando, revisione e audit.

Un cambio di generazione dell’account o dell’associazione cliente può rendere necessaria una nuova attivazione. Clienti eliminati, archiviati o sospesi non espongono cartelle ai destinatari. Il riferimento può essere disabilitato dall’Admin anche se il cliente o i destinatari non sono più disponibili.

La conferma personale Admin dura 30 minuti. Se manca o scade, il tentativo è riconciliato con il suo comando e le scelte restano nella pagina. Conferma l’identità e prepara un nuovo riepilogo. Se manca una risposta, usa **Verifica esito**: non ripetere alla cieca il salvataggio. L’anteprima del singolo comando dura cinque minuti, separatamente dalla conferma personale.

## Percorso Commerciale e Ufficio tecnico

Apri **Fascicoli Drive**, cerca nome cliente o titolo e usa **Apri cartella Drive**. La lista contiene soltanto riferimenti attivi selezionati per il tuo account corrente e non scaduti. Il controllo viene ripetuto anche aprendo direttamente l’URL CRM o l’azione di apertura.

Se hai già il diritto di consultare una scheda cliente, il suo riquadro **File condivisi** usa lo stesso riferimento. Una cartella concessa non apre automaticamente la scheda cliente, altri clienti, documenti, video o funzioni di gestione. I clienti nuovi o convertiti mostrano il riquadro vuoto fino a una scelta esplicita dell’Admin.

Per un tecnico, compresi Consulente, Backoffice e account con funzione tecnica aggiuntiva, l’Admin deve verificare che cartella, sottocartelle e metadati siano privi di pagamenti, riferimenti di pagamento, contratti firmati e note riservate. In mancanza della verifica esplicita l’attivazione tecnica è negata. Un fascicolo misto va tenuto fuori dal perimetro tecnico: non basta rinominarlo.

## Limiti effettivi di Google Drive

Il CRM registra solo URL, associazione, titolo, selezione e storico; non carica, importa, replica, indicizza o apre i contenuti Google sul server. Non crea cartelle Google, non modifica le ACL e non gestisce credenziali Google.

La scelta organizzativa di cartelle **chiunque abbia il link / lettore** resta esterna al CRM. Disabilitare il riferimento nel CRM toglie la sua scoperta e apertura dal CRM, ma non revoca un link già copiato e non impedisce l’inoltro. Il contenuto Google può cambiare senza una revisione CRM: chi gestisce la cartella deve mantenere coerente il perimetro, soprattutto per i tecnici. Non è promessa riservatezza Google equivalente al registro CRM.

## Implementazione e verifica

`DriveFolderReference` è una risorsa tipizzata distinta, registrata nel journal nativo immutabile `AdminRecordRevision` e nel relativo audit atomico. Non usa `DriveVideoReference`, `VideoEntry`, `Document` o un PDF segnaposto. Schema75 e migrazioni rimangono invariati.

Le letture verificano sessione registrata, account corrente, permesso della sezione, selezione nominativa congelata, generazioni di destinatario/autore/cliente, stato e scadenza. Le scritture Admin richiedono conferma personale, riepilogo firmato, confronto della revisione e serializzazione del comando. La selezione precede ricerca e proiezione; il collegamento diretto risponde senza dettagli quando non ammesso. L’unicità della cartella è controllata sull’ID canonico anche con URL alternativi o riferimenti disabilitati.

| Requisito | Prova del candidato |
| --- | --- |
| Link validato, nessun file o host arbitrario | `tests/drive-folder-policy.test.ts` |
| Sezione separata da cartella, nessuna gestione per operatori | Matrice ruoli pura e nativa |
| Tecnici, funzione aggiuntiva, dati riservati | Dinieghi e verifica esplicita del contenuto nella matrice |
| Un riferimento in elenco e nel cliente | Prova nativa e scenario browser |
| Bozza, attivazione, revoca, ripristino, ricerca e ricarica | Scenario browser su account sintetici |
| Accessi diretti GET/HEAD, isolamento e scadenza | Browser locale e prove native |
| Account/sessione/cliente revocati o modificati | Prove native su schema75 isolato |
| Audit atomico, concorrenza, risposta persa, nessun duplicato | Prove native con fallimento audit e riconciliazione |
| Conferma personale e conservazione delle scelte | Scenario browser con tentativo chiuso e nuova conferma |
| Nessuna modifica a video o documenti | Conteggi invariati nei test; confronto privato prima/dopo richiesto al rilascio |

La workflow `Selective client Drive folders` esegue prove native e browser su PostgreSQL effimero, solo fixture. Il collaudo browser usa `NODE_ENV=production npm run build` e `NODE_ENV=production npx next start --hostname 127.0.0.1 --port 3051`; la preparazione del database e il processo di test mantengono l’ambiente sintetico con i relativi guard. Le verifiche HTTP passano dalla sessione browser ordinaria; ogni tentativo di rete esterna è bloccato prima della connessione. Il runner locale supportato è `node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3051`, con ambiente sintetico e registro sessioni attivato dalla fixture. Non usare credenziali, URL o dati reali in quel database.

Il collaudo sintetico non attesta popolamento né apertura di cartelle reali. Dopo la qualificazione della funzionalità, gli abbinamenti reali richiedono la fonte privata ASUS e l’allineamento con Stella: i casi discordanti o non trovati rimangono sospesi. Nessun dato reale viene creato come fixture.

## Rilascio e recupero

Prima del rilascio: HEAD/CI esatti, riesame indipendente pertinente, piano esecutivo e backup/ripristino qualificati secondo i gate del mandato. Nessuna migrazione o backfill. Conservare integralmente video, documenti e grant preesistenti.

Il recupero applicativo compatibile conserva i lettori dei fascicoli, le revisioni e gli audit già registrati, mantenendo i controlli correnti. Sospende sul server tutti i nuovi comandi di gestione e sostituisce l’editor con un avviso esplicito. Non è il ritorno all’immagine storica senza modifiche: il pacchetto esecutivo deve qualificare questa composizione sul candidato reale. Non cancella righe del journal né modifica Drive.
