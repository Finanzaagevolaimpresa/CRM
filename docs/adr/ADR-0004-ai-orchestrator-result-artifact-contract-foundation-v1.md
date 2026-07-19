# ADR-0004 — AI Orchestrator Result & Artifact Contract Foundation v1

## Decisione
Introduciamo un contratto canonico TypeScript/Zod, versionato e hashato, per risultati e artifact sintetici dell'AI Orchestrator. Il catalogo copre esattamente i 13 job canonici e resta derivato da Job Catalog, capability e Worker Runtime Policy: non è una nuova autorità di scheduling o dispatch.

## Invarianti
Gli hash usano JSON canonico e domain separation. La completion accetta un draft strutturato, valida schema strict e limiti, calcola server-side payloadHash, artifactHash, manifestHash e resultHash, persiste risultato/artifact/source reference e solo dopo marca attempt/runtime come SUCCEEDED e appende l'evento runtime.

## Sicurezza operativa
La fondazione resta dormiente: nessun worker, handler registry, route, provider esterno, dispatch, scheduler, accesso CRM reale, AiRun o AiOutput. Provider e data mode sono vincolati a mock/synthetic.

## Rollback
Rollback applicativo: mantenere tutti i gate chiusi, ripristinare l'immagine PR76 e lasciare intatte le nuove tabelle. Non usare DROP/TRUNCATE/reset/down migration; eventuale restore database è procedura separata.
