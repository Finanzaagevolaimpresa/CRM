# Formati dei documenti selezionati — R01

Le versioni approvate e acquisite privatamente possono essere scelte nei perimetri
cliente, pratica e incarico tecnico anche quando il browser non dispone di
un'anteprima. L'Admin sceglie separatamente il permesso di download: selezionare
una versione senza quel permesso mostra soltanto nome e versione se il formato
non ammette anteprima. Il riepilogo esplicita questa differenza.

PDF, PNG, JPEG e testo UTF-8 mantengono la consultazione nel CRM. Prima della
risposta inline il server verifica anche estensione, MIME e firma/contenuto
dei byte già autenticati mediante checksum. I download restituiscono sempre
un allegato con MIME application/octet-stream, nosniff, CSP sandbox e no-store.

Office DOC/DOCX/XLS/XLSX/ODT/ODS, P7M, CSV, XML, WEBP e ZIP sono ammessi soltanto
come allegati. Le coppie estensione/MIME sono esplicite; application/octet-stream
è ammesso soltanto per le estensioni previste. Un file HTML, SVG, eseguibile,
con estensione DOCM/XLSM o con estensione/MIME incoerenti non diventa selezionabile.
Gli archivi non vengono estratti, né i documenti convertiti o inviati a servizi
esterni. ZIP resta escluso dal deposito tecnico, come prima; la sua eventuale
selezione riguarda soltanto documenti già ammessi dai percorsi ordinari.

Le autorizzazioni e i payload firmati non cambiano: stessa persona, stessa
versione, checksum, contesto, scadenza e decisione di download. Nessuna eredità
del permesso al caricatore, a un altro tecnico, a una pratica correlata o a
versioni future. Le selezioni passive esistenti conservano la stessa forma
canonica. Contratti e pagamenti mantengono il limite Admin/Amministrazione.

Le letture rivalidano il perimetro corrente; revoca, scadenza, lifecycle,
disattivazione, alterazione dei byte o del contesto impediscono la consegna.
Il percorso ordinario non apre i documenti acquisiti privatamente.
La rotta personale dell'Admin conserva il download autorizzato e la pagina
nasconde il collegamento all'anteprima quando il formato non la supporta.

## Qualifica e rilascio

Incremento distinto e dipendente dall'acquisizione PR221. Nessuna nuova tabella,
migration, dipendenza, binding, concessione o invio reale. La CI deve qualificare
l'HEAD proprio; le prove di PR221 non qualificano questo delta.

Prove previste: contratti e byte passivi, pacchetto DOCX sintetico senza
macro né relazioni esterne; DB isolato per i tre lettori, permesso assente/presente,
destinatario omesso, pratica estranea, revoca, lifecycle, checksum e riservatezza
finanziaria; browser nativo per deposito, revisione, acquisizione, riepilogo,
sola metadata, download esplicito e revoca con pagina aperta, desktop/mobile.
Le prove DB/browser si eseguono soltanto nella CI isolata già autorizzata.

Prima di qualsiasi rilascio servono candidato esatto, CI completa, riesame
pertinente, piano app-only e autorità specifica. Recupero soltanto con codice
compatibile con lo schema effettivo; nessun rollback automatico o down-migrate.
