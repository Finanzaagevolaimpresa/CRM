# Viste operative essenziali per ruolo

Il menu e la dashboard presentano solo le aree pertinenti, incrociando il ruolo
con i permessi personali correnti. Il commerciale conserva lead, offerte,
clienti propri, attività e il percorso «Stato e prossime azioni». I profili
tecnici `consulente` e `backoffice` conservano progetti, pratiche, documenti
pertinenti e attività; non hanno riquadri commerciali o amministrativi,
nemmeno a zero. Il collaboratore limitato non viene trasformato in commerciale.

I riepiloghi economici, di revisione e la pipeline generale sono esclusi dalle
viste operative ristrette. Anche il dettaglio esteso della dashboard resta
disponibile soltanto all'Admin che conserva tutti i relativi permessi. La
revoca di un permesso personale si riflette nella successiva lettura della
dashboard e del menu, senza richiedere un nuovo login.

Questa modifica riguarda la presentazione. Non attribuisce nuovi diritti e
non sostituisce l'enforcement server su URL, API, ricerca, documenti e
operazioni. Assegnazioni tecniche multiple, completamento dei moduli tecnici
e coda delle richieste all'Admin rimangono incrementi distinti. Nascondere le
voci dei moduli «In preparazione» non ne dichiara il completamento. Nessun
account reale viene riclassificato. La lettura circoscritta dei ruoli correnti
ha confermato i due codici tecnici e le restrizioni alle liste di clienti,
aziende, lead e servizi: le prove le riproducono su utenti sintetici, senza
usare identificativi o dati personali degli account reali.

## Verifica

La suite nativa `commercial-progress` aggiunge due scenari desktop/mobile
con due commerciali e due tecnici, ciascuno con record isolati non vuoti.
Verifica contatori positivi, dettaglio del proprio record, assenza del record
altrui, menu e riquadri estranei assenti, e restrizioni personali applicate
mentre la stessa sessione rimane aperta. Le restrizioni sono create solo nel
database effimero verificato dal guard. Le prove pure coprono anche il
collaboratore limitato e i gruppi vietati con valore zero.

Le regressioni storiche dei menu verificano ora insieme pertinenza del ruolo
e permesso corrente: gli override non fanno comparire aree amministrative nel
menu limitato. Le prove positive degli strumenti amministrativi conservano
attori pertinenti e quelle negative restano esplicite. Il test nativo della
riassegnazione lead usa un commerciale; un tecnico sintetico distinto rimane
responsabile dei progetti e delle pratiche del fixture.

La regressione del menu mobile conserva riapertura, resize e testi lunghi:
verifica «Stato e prossime azioni» per il commerciale e «Checklist documentale»
per il tecnico, con le rispettive voci estranee assenti anche quando un override
sintetico concede il solo permesso di base. La fixture usa i codici ruolo
pertinenti; non verifica autenticazione o autorizzazioni server.

Schema e migration restano invariati a 63. Nessun invio, concessione reale,
binding, provider o scheduler viene creato da questa modifica. La qualifica
CI e il riesame devono riferirsi all'HEAD definitivo di questo incremento;
le prove del predecessore non sono attribuibili al nuovo candidato.
