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
account reale viene riclassificato e la corrispondenza con i profili nominativi
del collaudo umano deve essere verificata separatamente.

## Verifica

La suite nativa `commercial-progress` aggiunge due scenari desktop/mobile
con due commerciali e due tecnici, ciascuno con record isolati non vuoti.
Verifica contatori positivi, dettaglio del proprio record, assenza del record
altrui, menu e riquadri estranei assenti, e restrizioni personali applicate
mentre la stessa sessione rimane aperta. Le restrizioni sono create solo nel
database effimero verificato dal guard. Le prove pure coprono anche il
collaboratore limitato e i gruppi vietati con valore zero.

Schema e migration restano invariati a 63. Nessun invio, concessione reale,
binding, provider o scheduler viene creato da questa modifica. La qualifica
CI e il riesame devono riferirsi all'HEAD definitivo di questo incremento;
le prove del predecessore non sono attribuibili al nuovo candidato.
