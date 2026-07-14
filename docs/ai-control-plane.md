# AI Control Plane v1

L'AI Control Plane governa l'uso degli agenti AI nel CRM FAI. La configurazione iniziale è **fail-closed**: il provider `mock` continua a funzionare localmente, mentre nessuna chiamata a un provider esterno è consentita finché tutti i controlli descritti qui non risultano abilitati.

## Gate di esecuzione esterna

Per una chiamata OpenAI devono essere vere contemporaneamente tutte le condizioni seguenti:

1. `AI_EXTERNAL_PROVIDERS_ENABLED="true"` nell'ambiente server;
2. switch globale `externalProvidersEnabled` attivo nel database;
3. modello dell'agente presente nella allowlist non vuota `AI_ALLOWED_MODELS`;
4. agente attivo e configurato con provider `openai` e un modello esplicito;
5. utente autorizzato con entrambi i permessi `ai.run` e `ai.external.run`;
6. conferma esplicita dell'operatore per quella singola esecuzione;
7. limite orario per utente non superato;
8. `AI_API_KEY` presente esclusivamente lato server.

Se un controllo manca, è incoerente o non è leggibile, il runtime nega l'esecuzione esterna. Non esiste un modello esterno autorizzato per default: `AI_ALLOWED_MODELS=""` significa che nessun modello OpenAI può essere usato.

Questo è un doppio kill switch:

- il gate ambiente viene gestito nel deploy/secret manager e richiede riavvio o nuovo deploy;
- lo switch database può bloccare operativamente le chiamate esterne dal pannello riservato.

Disattivare uno solo dei due è sufficiente a fermare nuove esecuzioni esterne. La modifica dello switch database è auditata e non espone chiavi API.

## Configurazione ambiente

Esempio sicuro iniziale:

```env
AI_PROVIDER="mock"
AI_API_KEY=""
AI_MODEL=""
AI_EXTERNAL_PROVIDERS_ENABLED="false"
AI_ALLOWED_MODELS=""
```

Solo dopo approvazione e collaudo in staging:

```env
AI_EXTERNAL_PROVIDERS_ENABLED="true"
AI_ALLOWED_MODELS="<modello-approvato-1>,<modello-approvato-2>"
AI_API_KEY="<secret-server-side>"
```

`AI_ALLOWED_MODELS` è una lista separata da virgole. Valori vuoti, duplicati o nomi non presenti nella lista non autorizzano implicitamente altri modelli. La chiave non deve essere inserita nel database, nei prompt, nei log, in Git o in variabili `NEXT_PUBLIC_*`.

`AI_PROVIDER` e `AI_MODEL` restano variabili di compatibilità usate dalla diagnostica; non scelgono provider o modello dei run operativi. Questi ultimi usano esclusivamente la configurazione del singolo agente. Per un test OpenAI, `AI_PROVIDER=openai` e `AI_MODEL=<modello>` devono indicare un modello già allowlisted e configurato su un agente OpenAI attivo; anche la diagnostica rispetta gate, permessi e rate limit.

## Configurazione e uso degli agenti

Nel pannello **Impostazioni → Agenti AI** un amministratore autorizzato può:

- attivare o disattivare un agente;
- scegliere `mock` oppure `openai`;
- scegliere, per `openai`, soltanto un modello presente nella allowlist server;
- aggiornare manualmente il prompt, con controllo di versione e audit.

La pagina non mostra mai `AI_API_KEY`. L'agente `mock` non invia dati all'esterno. Per un agente OpenAI, il form nel fascicolo cliente mostra il provider, ricorda le categorie di dati minimizzate e richiede una conferma per ogni esecuzione. Il consenso operativo non sostituisce basi giuridiche, informative, DPIA o altre valutazioni privacy dell'azienda.

Il payload esterno è costruito server-side e contiene solo il contesto necessario e autorizzato: dati essenziali del cliente/azienda, contesto di servizio e progetto, stati sintetici di checklist/documenti e task, oltre alle istruzioni operative. Documenti e checklist classificati come sensibili sono esclusi anche quando l'operatore può consultarli nel CRM. Non vengono trasmessi file, contenuti binari, percorsi storage, checksum, chiavi o dati fuori dal perimetro ABAC dell'utente.

Per i run OpenAI il CRM non duplica il payload o le istruzioni operative in `AiRun.input`: conserva collegamenti al contesto CRM, categorie dichiarate, stato, versione agente, conteggi token e identificativo tecnico minimizzato della richiesta. L'output utile resta una bozza applicativa separata soggetta a revisione umana.

## Output, revisione e invii

Ogni output nasce come bozza interna e richiede revisione umana. Generatore, revisore e approvatore restano separati secondo i permessi applicativi. L'AI non promette contributi, finanziamenti, ammissibilità o approvazioni e le informazioni normative o di bando devono essere verificate sulle fonti ufficiali.

Il Control Plane **non invia automaticamente** email, messaggi, documenti, domande o comunicazioni ai clienti o a soggetti esterni. L'eventuale uso di un output approvato resta un'azione umana separata.

## Trattamento dati OpenAI

Il runtime usa la Responses API con `store: false`. Questo evita la conservazione dello stato applicativo della risposta per il successivo recupero tramite API; non equivale però a Zero Data Retention.

Secondo la documentazione OpenAI API sui controlli dei dati, i dati API non sono usati per addestrare i modelli per impostazione predefinita. I log di abuse monitoring possono essere conservati fino a 30 giorni. La Responses API può mantenere application state per 30 giorni quando la memorizzazione è attiva; il CRM imposta esplicitamente `store: false`. Eventuali controlli Modified Abuse Monitoring o Zero Data Retention richiedono idoneità e configurazioni specifiche dell'organizzazione/progetto OpenAI e devono essere verificate separatamente: il CRM non dichiara né presume ZDR. Riferimento operativo: [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data).

## Separazione staging e produzione

Staging e produzione devono usare:

- progetti OpenAI distinti;
- chiavi API distinte e ruotabili;
- allowlist modelli, budget e limiti distinti;
- database e switch Control Plane distinti;
- utenti/ruoli e audit distinti;
- nessun dato cliente reale in test, salvo autorizzazione e necessità documentata.

Abilitare prima staging, verificare blocchi fail-closed, permessi, conferma, rate limit, audit e assenza di segreti nei log. Solo dopo il collaudo replicare esplicitamente la configurazione approvata in produzione: non copiare file `.env` o chiavi tra ambienti.

## Procedura di attivazione

1. Lasciare entrambi i gate disattivati e verificare il funzionamento `mock`.
2. Creare un progetto OpenAI dedicato allo staging, una chiave con privilegi minimi, budget e limiti.
3. Impostare in staging una allowlist esplicita e il gate ambiente.
4. Attivare lo switch database dal pannello autorizzato e controllare l'audit.
5. Assegnare `ai.external.run` solo ai ruoli/operatori approvati.
6. Configurare un solo agente OpenAI e completare test senza dati cliente reali.
7. Verificare kill switch, errori, rate limit, revisione/approvazione e nessun invio automatico.
8. Ottenere l'approvazione interna privacy/sicurezza prima dell'uso con dati reali e della produzione.

In caso di anomalia, disattivare subito lo switch database; se serve un blocco infrastrutturale, impostare anche `AI_EXTERNAL_PROVIDERS_ENABLED="false"`, revocare/ruotare la chiave e verificare audit e log tecnici minimizzati.
