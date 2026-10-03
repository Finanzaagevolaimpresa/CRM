# Scheda di avanzamento e ripresa verificata

Il fascicolo collega la pagina `/progress`, ricercabile per cliente e senza taglio alle prime dieci priorità. La scheda riusa le pratiche controllate, i task, i contratti e le versioni del dossier esistenti. Non crea un secondo registro commerciale.

La prossima azione dipende dai prerequisiti attuali, in questo ordine: impedimento riservato generico, preventivo, formalizzazione, accredito, materiali, collegamento servizio, avvio esplicito, dossier, revisione e consegna della versione corrente. Un prerequisito sconosciuto richiede verifica; non viene trattato come soddisfatto. Anche dopo l'avvio, un prerequisito divenuto mancante è evidenziato.

La pianificazione usa un task associato esplicitamente alla pratica e all'azione. Fra più task della stessa azione vengono prima la scadenza più vicina, poi la priorità e infine l'ID. Un task non associato non fornisce automaticamente responsabile o scadenza. Valori mancanti restano **Da assegnare** e **Da pianificare**. I task relativi alle verifiche amministrative usano un riferimento generico: non codificano lo stato di firma o pagamento.

## Dichiarazione e documento

La scheda contratto permette una dichiarazione esplicita della firma con data e fonte. L'audit registra autore, momento, sequenza e dichiarazione precedente. La modifica conserva lo storico; nessun aggiornamento di `Contract.status`, `signedAt`, documento, pagamento o readiness deriva dalla dichiarazione.

Il salvataggio rivalida sessione, ruolo, dinieghi e contesto; serializza sul cliente e sul contratto. Replay identici della dichiarazione restituiscono la ricevuta esistente senza un nuovo audit. Una modifica concorrente richiede rilettura. Le note libere non costituiscono una dichiarazione. Upload, selezione della versione, registrazione della firma, accredito e avvio restano operazioni distinte.

Il percorso usa i record già salvati dopo una riapertura. Gli input non salvati e la selezione locale dei file non vengono promessi come persistenti. Il caricamento interrompe il gruppo su una risposta incerta e richiede la riconciliazione dell'elenco documenti prima di un nuovo invio.

## Perimetro di accesso

La proiezione delle pratiche usa `listAccessiblePracticeReadiness`; il dossier usa il controllo corrente del suo dettaglio. Contratti, dichiarazioni e pagamenti sono letti solo con i rispettivi permessi effettivi e il vincolo di ruolo di PR179. I controlli individuali sono conservati. Un lettore operativo non riceve il tipo di impedimento finanziario né i relativi identificatori. La consultazione del cliente non concede le pratiche o i dossier assegnati ad altri.

La consegna è riconosciuta soltanto quando riguarda la versione corrente approvata. La consegna di una versione precedente non rende consegnata una nuova bozza.

## Qualifica richiesta

- `tests/customer-progress.test.ts`: ordine dei prerequisiti, proiezione generica dei dinieghi, versione consegnata, selezione deterministica dei task e dichiarazione esplicita.
- `tests/contract-signature/service-db.test.ts`: dichiarazione separata dalla firma, storico, replay concorrente e sessioni/permessi correnti; conserva le regressioni della firma.
- `tests/contract-signature/signature.spec.ts`: riapertura prima e dopo upload, dichiarazione che non firma, registrazione della firma con pagamento atteso e perdita della risposta dopo upload realmente salvato.
- `tests/financial-privacy/privacy.spec.ts`: HTML della nuova scheda per tutti i ruoli e dinieghi finanziari individuali.
- `tests/practice-readiness-browser/readiness.spec.ts`: il banco completo comprende un caso sintetico Dossier Preanalisi, fonti/versioni, incasso sintetico, avvio, revisione nominativa, approvazione, consegna manuale simulata e replay. Una nuova sessione dimostrativa ricostruisce gli esiti dalla scheda, con dodici priorità estranee, pianificazione esplicita, riapertura e revoca del ruolo.

Gli screenshot e i verbali sono generati soltanto dai test realmente eseguiti. La comprensibilità automatizzata non è una firma umana; non attesta AI esterna, email ricevute o adozione produttiva. I risultati del candidato esatto vanno riportati nella PR, distinguendo ogni suite e i controlli saltati.

## Invarianti e recupero

Base iniziale: `85fa76d3d1c110da44c892859a70f9151b79cb7f`. Nessuna incorporazione di PR172/154. Nessuna migrazione, dipendenza aggiuntiva, modifica del lock o impostazione di ambiente. Audit e guardie restano integri. L'audit completo della base è attualmente bloccato da GHSA-vfj7-8cjw-p6xm; il prototipo di backport non è adottato da questo ramo.

Questa proposta non esegue merge, installazione, deploy o scritture su dati reali. Finché non è adottata, la produzione non richiede rollback. Un futuro piano di rilascio dovrà preservare le dichiarazioni append-only già registrate e non ripristinare codice che allarghi la visibilità finanziaria.
