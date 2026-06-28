# Smoke test manuale CRM FAI — Step 6.5

Checklist manuale da eseguire in ambiente interno dopo deploy.

- [ ] Login con utente interno attivo.
- [ ] Dashboard: aprire tutte le card statistiche e verificare navigazione alle sezioni.
- [ ] Lead: creare un lead, aprirlo da **Apri**, aggiornare lo stato e tornare alla lista.
- [ ] Cliente: aprire un fascicolo cliente, verificare schede reali, servizi, documenti, output AI e audit log.
- [ ] Cliente: aggiornare stato servizio e assegnazione se presenti utenti/servizi.
- [ ] Progetto: creare un progetto base, aprirlo, visualizzare dati e voci di spesa.
- [ ] Documenti: registrare metadati documento, collegarlo a servizio/sezione, verificare che il download non disponibile sia disabilitato con spiegazione.
- [ ] Pre-analisi: creare/aprire una pre-analisi e verificare stato da revisionare o stato reale.
- [ ] AI: eseguire un run AI mock e verificare che l'output resti bozza interna da revisionare.
- [ ] AI: approvare un output solo con utente dotato di `ai.approve`; se flagged, verificare warning e pulsante non attivo.
- [ ] Dossier: aprire un dossier, visualizzare contenuto reale e verificare export PDF/DOCX disabilitati nel MVP.
- [ ] Contratti: creare/aprire un contratto e verificare stato.
- [ ] Pagamenti: registrare un pagamento se è presente un contratto e verificare stato pagamento.
- [ ] Task: visualizzare task e completare una attività aperta.
- [ ] Settings: utenti e ruoli mostrano dati reali; azioni non disponibili non devono essere cliccabili senza effetto.
- [ ] Logout.

Nota compliance: nessun output AI viene inviato automaticamente al cliente; ogni contenuto AI resta bozza interna con revisione umana obbligatoria.
