# Deploy interno CRM FAI

Checklist per pubblicazione interna del CRM FAI, senza area cliente pubblica e senza automazioni di invio verso clienti.

## Ambiente e segreti
- [ ] Impostare `NODE_ENV=production` / ambiente production.
- [ ] Configurare `DATABASE_URL` verso PostgreSQL production persistente.
- [ ] Configurare `AUTH_SECRET` production robusto e non condiviso.
- [ ] Abilitare solo HTTPS: i cookie di sessione firmati devono transitare su connessione sicura.
- [ ] Verificare assenza di fallback admin in production.

## Dati, storage e backup
- [ ] Usare database PostgreSQL persistente.
- [ ] Pianificare backup database automatici e test periodico di ripristino.
- [ ] Usare storage documenti privato, non indicizzato e non pubblico.
- [ ] Verificare permessi su documenti sensibili: CRIF, Centrale Rischi, identità, dichiarazioni fiscali, bilanci, estratti conto, contratti, contabili pagamento.

## Utenti e permessi
- [ ] Creare utenti admin iniziali con credenziali personali.
- [ ] Disattivare o cambiare eventuali credenziali temporanee.
- [ ] Test login multiutente con ruoli: admin, direzione, commerciale, consulente, revisore, backoffice, amministrazione, collaboratore_limitato.
- [ ] Test permessi granulari e limitazioni per assegnazione.
- [ ] Test blocco utenti disattivati.

## Funzioni operative
- [ ] Confermare che non esista area pubblica cliente o portale cliente.
- [ ] Test download documenti e audit di accesso/download.
- [ ] Test audit log per login, logout, modifiche utenti, documenti sensibili, contratti, pagamenti, assegnazioni e approvazioni AI.
- [ ] Verificare che ogni output AI resti bozza interna con revisione umana obbligatoria.
- [ ] Verificare che nessun output venga inviato automaticamente al cliente.
