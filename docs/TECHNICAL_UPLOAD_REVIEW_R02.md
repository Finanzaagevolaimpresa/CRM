# Deposito privato e revisione personale dell’Admin — candidato PR220

Base PR219 `aa30d5c8ca4f483ae6cd0e77ec9fade8794646b4`, schema66. Questo documento descrive il candidato corrente, non un rilascio. Le qualifiche del precedente HEAD dormiente sono storiche e non qualificano le nuove route.

## Percorso

L’Admin personale, nella gestione incarichi su progetto/pratica, sceglie «Caricare documenti tecnici», finalità, formati, dimensione per file, numero di file e spazio totale. Anteprima e conferma con step-up legano il profilo alla persona e alla versione dell’incarico. Nessun vecchio incarico eredita un profilo mancante.

Il tecnico apre «Deposita un documento per l’Admin», sceglie titolo e file, controlla il riepilogo e conferma una sola volta. Il server ricostruisce nome, formato passivo, hash e dimensione dai byte effettivi. Il deposito è fuori da Document/DocumentVersion, fascicolo, ricerca, notifiche, report e allegati email.

L’Admin apre «Revisiona i documenti depositati», consulta il file esatto, sceglie approvazione privata o rifiuto e indica il motivo. Il motivo è dichiaratamente visibile all’autore finché ammesso. Anteprima firmata e step-up conservano una decisione finale immutabile per file, audit minimo e ricevuta dopo commit. Il ruolo Admin di un’altra persona non eredita questa autorità.

La risposta persa si riconcilia tramite il comando originale. La ricevuta non attribuisce accesso a titolo, motivo o byte. Nessun retry con un nuovo comando, cancellazione o rinnovo automatico.

## Confine della revisione

Approvazione privata e acquisizione nel fascicolo sono decisioni distinte. L’acquisizione canonica, la classificazione e la scelta personale della visibilità restano un incremento da completare. Il writer ordinario crea subito un documento leggibile secondo i diritti del contesto: chiamarlo con un attore artificiosamente privilegiato amplierebbe il perimetro. Nessuna approvazione del deposito crea Document, allegati, concessioni, avanzamenti o email. Le condivisioni esistenti restano legate a versioni esplicite.

## Controlli

Lock correnti su registry/key, directory, utenti, sessione, autorità personale, contesto e incarico. Deposito con lock esclusivo dell’incarico per la quota. Letture e revisione verificano ruolo, permessi, epoch, relazione canonica, lifecycle, scadenza e revisione. L’Admin usa la propria sessione, senza impersonare il tecnico. Relazioni ordinarie e secondo tecnico non concedono il deposito; GET e letture non scrivono.

Massimo 25 MiB per file e 20 file per revisione, entro il totale scelto. ZIP e metadati finanziari esclusi; il nome non prova il contenuto semantico. Formati opachi non estratti/eseguiti; inline soltanto formati passivi verificati, senza cache e con sandbox/nosniff/no-referrer.

Storage locale approvato, namespace technical-submissions/v1, chiave derivata da persona/target/incarico/revisione e comando/sessione, senza nomi privati. Scrittura esclusiva e sincronizzata; hash, dimensione e identità ricontrollati; collegamenti e file parziali rifiutati. Orfani dopo rollback restano privati e consumano quota, anche i file vuoti con riserva massima. Nessun cleanup. Il solo comando originario può riusare byte completi identici.

Riga/audit/quota sotto serializable; vincoli differiti risolti prima dell’uscita dal callback ORM. COMMIT nativo verificato separatamente. Domini HMAC distinti da concessioni, lavoro ed email; audit della revisione con solo stato, mai motivo o metadati.

## SQL e prove

`scripts/technical-upload/schema67-draft.sql` resta una bozza isolata fuori Prisma: due tabelle inizialmente vuote, depositi e revisioni immutabili, FK restrittive, controllo audit atomico e un solo esito per deposito. Non aggiorna `_prisma_migrations`. Prima della distribuzione servono promozione SQL67, hash/binding, piano, riesame e autorità produttiva esatti.

CI dedicata: base66, rifiuto base65, rollback degli oggetti e conservazione delle righe precedenti; servizi pubblici con incarichi personali sintetici, letture/dinieghi, revoca, concorrenza, audit mancante, esito perso e quote fisiche. Browser nativo con due tecnici e due commerciali: selezione Admin, deposito, approvazione/rifiuto, URL negati, assenza dagli indici ordinari e recupero di entrambe le risposte perse. Screenshot desktop/mobile dei componenti effettivi. Esiti attribuiti soltanto all’HEAD eseguito.

Restano le correzioni preliminari già qualificate: controlli della condivisione lead disabilitati prima dell’idratazione e osservazione immediata dell’uscita del processo nella regressione PR88. Nessun controllo server indebolito o contenuto storico alterato.

Nessun nuovo provider, cron, binding, concessione reale, email, backup, down-migrate o mutazione produttiva. Non dichiarare pronto il rilascio dalla sola integrazione: qualifica completa, SQL/piano e riesame sono ancora necessari.
