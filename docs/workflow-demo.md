# Workflow demo interno CRM MVP FAI

Questa guida serve solo per test interni. Nessun output AI è inviato automaticamente al cliente: ogni bozza deve restare interna, con revisione umana obbligatoria e approvazione esplicita.

## Caso demo

- Azienda: SRL organizzazione eventi e produzioni video
- Provincia: Brescia
- Richiesta: 40-50K
- Spese: marketing, attrezzature tecniche, eventi, liquidità affitto, furgone
- DURC: ok dichiarato
- CRIF/Centrale Rischi: ok dichiarato
- Persone collegate: due soci decisori

## Flusso da testare

1. **Lead**: creare un lead per uno dei due soci decisori, indicando provincia Brescia, interesse finanza agevolata e investimento dichiarato 40-50K.
2. **Cliente**: convertire/registrare il cliente come società o soggetto societario collegato al lead.
3. **Azienda**: creare la società SRL con attività di organizzazione eventi e produzioni video, provincia Brescia, DURC ok dichiarato.
4. **Persone collegate**: registrare i due soci decisori e collegarli all'azienda con ruolo decisionale.
5. **Progetto**: creare un progetto per richiesta 40-50K, settore eventi/video, provincia Brescia.
6. **Spese**: inserire marketing, attrezzature tecniche, eventi, liquidità per affitto e furgone come spese progettuali.
7. **Documenti**: caricare metadata documentali usando solo `storagePath` privato; verificare che upload e download richiedano permessi e generino audit log.
8. **Pre-analisi**: creare una pre-analisi interna con DURC ok dichiarato e CRIF/Centrale Rischi ok dichiarati.
9. **AI output**: eseguire il mock agent; verificare che l'output nasca con `needs_review` o `flagged` e `requiresHumanReview = true`.
10. **Revisione**: controllare che frasi vietate come “contributo garantito” o “100% garantito” siano flaggate e non usabili senza revisione.
11. **Dossier**: creare o modificare un dossier interno, mantenendo traccia audit della modifica.
12. **Contratto**: registrare un contratto solo manuale/interno; nessun invio automatico al cliente.
13. **Pagamento**: registrare il pagamento e verificare l'audit log.

## Controlli attesi

- Cookie non firmati, scaduti o malformati non autenticano l'utente.
- Ogni server action critica richiama `requirePermission()`.
- Le validazioni server bloccano input vuoti, importi negativi, email non valide, path pubblici o traversal nei documenti.
- L'approvazione AI richiede `ai.approve` e salva `approvedById` e `approvedAt`.
- Download documentale richiede `document.download` e registra `document_download` in audit log.
