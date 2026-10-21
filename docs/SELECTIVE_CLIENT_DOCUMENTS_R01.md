# Documenti scelti nel fascicolo cliente

Questo incremento estende l'accesso selettivo del cliente alle versioni documentali scelte personalmente dall'Admin già titolare del binding `client-sharing`. Non crea una nuova autorità e non concede accessi durante il rilascio. La qualifica e l'eventuale distribuzione devono essere attribuite al commit esatto; questa guida descrive il comportamento candidato, non un rilascio già avvenuto.

## Percorso e scelta

Da **Clienti → Apri fascicolo → Condividi accesso selettivo**, scegliere il destinatario esistente, la scadenza e i campi o documenti da mostrare. È possibile condividere solo documenti senza selezionare campi anagrafici. I tre campi disponibili restano nome/denominazione, tipo e stato; nessuna nota, contatto o informazione finanziaria viene aggiunta implicitamente.

Ogni documento è indicato con titolo, nome del file e versione. La scelta è esplicita: massimo 20 versioni, PDF, testo semplice, PNG o JPEG, massimo 25 MiB per file. Il catalogo di gestione è limitato a 100 documenti e 200 versioni e segnala quando il limite è raggiunto. La visualizzazione e il pulsante di download sono scelte separate; il divieto di download non può impedire screenshot o copie di contenuti già visualizzati.

L'anteprima riporta soltanto i campi e le versioni selezionate. La conferma richiede la verifica di sicurezza della sessione personale. L'accesso appare in **Clienti condivisi con me**. La pagina ordinaria del cliente e i normali URL dei documenti restano esclusi per un destinatario con perimetro selettivo: non diventano vie alternative al fascicolo completo.

Contratti, pagamenti e documenti collegati alla firma o alla contabilità restano riservati ad **Admin e Amministrazione**, anche se classificati erroneamente come documenti ordinari o se esiste un vecchio permesso positivo. La selezione personale non supera questo limite. Gli altri perimetri indipendenti, i dinieghi espliciti, le scadenze e il cestino continuano ad applicarsi.

## Validità della decisione e lettura

La decisione V2 lega destinatario, sessioni correnti, cliente, campi, versioni, checksum, stato documentale, scadenza e facoltà di download. Viene riletta nella transazione di conferma e a ogni richiesta del file. Le decisioni V1 già presenti mantengono il loro formato e la loro verifica: non acquisiscono documenti.

Una nuova versione, una modifica dei metadati, un collegamento finanziario o un cambio di contesto rende inutilizzabile la vecchia decisione. Ripristinare successivamente i valori precedenti, anche retrodatando `updatedAt`, non riattiva il vecchio accesso. Occorre una nuova scelta personale. Non è prevista eredità automatica delle nuove versioni.

La lettura autorizzata usa il percorso dedicato `/shared-clients/[id]/documents/[versionId]`, controlla bytes e checksum entro il limite, restituisce intestazioni private/no-store, sandbox e nosniff, e registra un audit minimizzato nella stessa transazione di ammissione. Se permessi, audit, contenuto o validità non sono verificabili, non restituisce il file. Nessun percorso dello storage viene esposto al destinatario. Revoca e cambi di ruolo si applicano alla sessione già aperta alla richiesta successiva.

I lock sono acquisiti nell'ordine esistente per autorità, persone/sessioni, cliente e insieme ordinato delle risorse; poi documenti e versioni. La conferma conserva comando, concessione, revisione e audit atomici. Replay e risposta persa usano la ricevuta esistente senza duplicare la scelta.

## Schema59 e recuperabilità

### Anteprima nei documenti ordinari

Nell'elenco Documenti e nel fascicolo cliente, «Visualizza» apre il file in una nuova scheda; «Scarica» resta distinto. L'anteprima ammette PDF, PNG, JPEG e testo UTF-8 fino a 25 MB, verificando estensione e firma dei byte. HTML, SVG, archivi e altri formati rimangono scaricabili soltanto con i permessi correnti. Non sono convertiti né inviati a servizi esterni.

Il nuovo percorso `/documents/[id]/view` usa la stessa ammissione transazionale del download, compreso il limite finanziario, la sessione corrente, i perimetri e il checksum. Registra `document_view` senza inventare un download. Non acquisisce accessi dalla concessione selettiva: i percorsi ordinari e selettivi restano distinti. La risposta usa inline, no-store, sandbox e nosniff. L'anteprima non impedisce di conservare byte già visualizzati.

Le regressioni native verificano entrambe le route per gli otto ruoli, le versioni e la revoca a sessione aperta. Due scenari aggiuntivi desktop/mobile cliccano «Visualizza», controllano la decodifica effettiva di un'immagine privata e il rifiuto della riapertura dopo il cestino. Altri due scenari usano Chromium completo e un PDF sintetico valido: richiedono il caricamento effettivo di una pagina, acquisiscono le schermate e provano il diniego alla riapertura. La presenza del lettore PDF integrato rimane una capacità del browser.

`20261021080000_selective_client_documents_v1` parte dal prefisso schema58 immutato. Aggiunge `Document.selectiveEpoch` e aggiorna i vincoli dei payload per accogliere V2 preservando V1. Otto trigger mantengono la generazione monotona e invalidano le decisioni quando cambiano documento, versione, riferimenti di contratto/pagamento/formalizzazione/materiali, azienda o contesto della pratica. Le generazioni già esistenti di cliente, progetto e servizio restano nel contenuto verificato.

La migration non crea destinatari, autorità, concessioni o file. Prima della produzione servono SQL/hash/target esatti, riesame pertinente, autorizzazione specifica, qualifica dell'immagine schema59 e preflight fresco. Nessun down-migrate o ritorno a codice che ignora questi controlli. Nessun nuovo backup o restore DB è dedotto dalle autorizzazioni precedenti.

## Qualifica prevista sul candidato

La CI isolata richiede 40 prove PostgreSQL e 8 scenari browser nativi senza errori o skip. Copre selezione di soli documenti, byte/versione esatti, accessi ordinari negati, revoca e cambio ruolo a sessione aperta, riclassificazione finanziaria e successivo ripristino, cambi di versione, audit fallito, risposta persa e concorrenza osservata tramite lock PostgreSQL. Due scenari aprono realmente PDF e PNG selezionati da «Consulta versione», verificano il contenuto, il download negato e la revoca. I collegamenti ai file sono nativi, senza prefetch; la sandbox ammette solo immagini della stessa origine. Le schermate desktop/mobile devono essere acquisite e ispezionate.

La qualifica SQL parte da schema58 popolato con dati sintetici e storia V1, confronta tutte le righe e i 58 checksum precedenti, inietta un errore prima del COMMIT e prova l'assenza di effetti parziali, la generazione monotona e il rifiuto del replay. PR140 conserva concessioni V1/V2, versioni, bytes, generazioni e revoche attraverso riavvio e ripresa della sola immagine compatibile.

Le prove locali dei criteri di selezione, lint e typecheck non sostituiscono PostgreSQL, browser, build Linux o recuperabilità dell'immagine. Il pieno controllo personale di ulteriori campi, la modifica/caricamento selettivi e le comunicazioni residue restano incrementi distinti.
