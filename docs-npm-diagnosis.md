# Diagnosi npm install

## Verifiche eseguite

1. Registry npm configurato: `npm config get registry` restituisce `https://registry.npmjs.org/`.
2. Registry custom per scope Prisma: `npm config get @prisma:registry` non risultava configurato; ora `.npmrc` lo imposta esplicitamente a `https://registry.npmjs.org/`.
3. Versioni Prisma: `prisma` e `@prisma/client` erano entrambe `^5.22.0`; ora sono pin esatti `5.22.0` per evitare risoluzioni divergenti in lockfile.
4. Compatibilità Prisma CLI/Client: CLI e client restano sulla stessa versione esatta `5.22.0`.
5. Errore 403: i test di rete mostrano che il 403 arriva dal proxy di ambiente (`HTTP_PROXY`/`HTTPS_PROXY` e `npm_config_http_proxy`/`npm_config_https_proxy`) prima del registry npm. La patch elimina ambiguità di configurazione progetto, ma un blocco proxy esterno al repository può ancora impedire il download.

## Patch minima

- Aggiunto `.npmrc` locale con registry npm pubblico e registry esplicito per scope `@prisma`.
- Pin esatto di `prisma` e `@prisma/client` alla stessa versione.
- Nessuna modifica ad architettura, Prisma o PostgreSQL.
