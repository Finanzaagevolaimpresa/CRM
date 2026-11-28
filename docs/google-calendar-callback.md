# Rientro Google Calendar con sessione Strict

Mandato: FAI-CRM-GOOGLE-CALENDAR-CALLBACK-20261128-R01.
Baseline: PR264, commit `0eb4c878bb70d3e377572fe46fc6567a6e1c538f`, schema78.

Il ritorno da Google è una navigazione da un sito diverso. Il cookie generale
rimane `SameSite=Strict`: non accompagna il primo GET del callback. In PR264
middleware e callback richiedevano subito quel cookie e portavano a login.

Il solo percorso esatto `/settings/integrations/google-calendar/callback`
ammette ora GET e POST attraverso il middleware. Il GET non scambia codici,
non crea credenziali e non apre la scheda CRM: restituisce un documento isolato.
Il documento elimina la query dalla propria voce di cronologia e invia i soli
campi canonici in POST allo stesso percorso. CSP con nonce, nessuna risorsa
esterna, referrer limitato alla sola origine e no-store proteggono il passaggio; gli errori del provider
non sono riportati. Con JavaScript disabilitato resta il pulsante esplicito.
La pagina di trasporto usa `strict-origin`: un form con `no-referrer` invierebbe
`Origin: null`, impedendo al controllo CSRF esistente di verificare l'origine.
Path e query restano esclusi dal referrer anche nel percorso manuale.
Dinieghi e redirect finale mantengono `no-referrer`.

Il POST controlla origine, Fetch Metadata, formato e dimensione del corpo,
sessione attiva e vincolo del pilota. Il servizio esistente ricontrolla l'attore,
lo state, il binding alla sessione originale, la scadenza e il consumo singolo
prima dello scambio PKCE. Annullamento e scambio fallito consumano il tentativo;
un esito incerto richiede un nuovo consenso, senza ripetere il codice.
Sessione assente, replay, binding errato e altri profili terminano con una
risposta controllata. Il solo redirect di successo contiene un esito fisso.

Non cambiano ruoli, scope, cookie generale, configurazione, provider o schema.
La connessione personale richiede sempre il consenso della persona autorizzata.
La modifica non crea appuntamenti, invitati, worker o invii.

## Qualifica

Il workflow `Calendar callback cross-site` usa lo stesso test browser contro
due checkout: la baseline PR264 immutabile e la testa candidata. Il provider
sintetico è su `127.0.0.1`, il CRM su `localhost`: sono siti distinti, non
soltanto porte diverse. Il test verifica il GET senza cookie Strict, il POST
con la stessa sessione, PKCE, consumo singolo e lettura della disponibilità.
Le prove successive coprono annullamento, sessione assente o revocata, altra
sessione dello stesso utente, state errato/scaduto, replay, errore del provider,
profili esclusi, pagina senza risorse terze e POST di origine errata.
Il simulatore rifiuta ogni chiamata esterna; non simula appuntamenti.
Trace, video e screenshot sono disattivati; il rapporto non contiene URL OAuth
o valori opachi. Gli esiti effettivi e gli hash appartengono al rapporto della
delivery, non sono presunti dal presente documento.

Le prove operative esistenti conservano le verifiche Admin, Setter, commerciale
e tecnico, usando ora Strict e il POST autenticato del callback.
Le prove di servizio verificano anche il consumo singolo dell'annullamento.

## Rilascio e rientro

Merge e rilascio richiedono CI verde della testa finale, riesame indipendente
pertinente e qualifica esecutiva del target corrente. Nessuna migrazione o
variazione dei secrets è necessaria. Il rientro è l'immagine PR264 verificata,
con la stessa configurazione e schema78; non richiede ripristino del database.
State già consumati restano consumati. Le credenziali personali eventualmente
registrate restano compatibili con PR264; ripristinare l'immagine precedente
reintroduce il difetto nel nuovo collegamento, senza cambiare i dati.
Prima del rilascio verificare anche l'assenza di logging dei parametri OAuth
nel proxy effettivamente in esecuzione. Il postflight conserva baseline,
salute, connettore WordPress e perimetro del pilota. Il collaudo personale finale
si limita al collegamento e alla disponibilità, senza eventi o invitati.

Riferimenti: [Google OAuth Web Server](https://developers.google.com/identity/protocols/oauth2/web-server),
[SameSite e sito del documento](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html).
[Effetto della Referrer Policy su Origin](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy#effect_on_the_origin_header).
