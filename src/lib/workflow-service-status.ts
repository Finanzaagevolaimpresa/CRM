/** Public operational explanations. Never expose provider errors, credentials,
 * private policy contents or raw exception text in the lead card. */
export function workflowServiceHoldMessage(reason: string) {
  if (reason === 'WORKFLOW_SERVICE_QUOTA') return 'Limite della delega raggiunto. L’admin verifica quota totale e giornaliera; il runner non supera il limite.';
  if (reason === 'NEWSLETTER_NATIVE_ADMISSION_DENIED' || reason === 'NEWSLETTER_POLICY_UNAVAILABLE') return 'Preferenze o policy marketing non ammesse. L’admin verifica consenso attuale, disiscrizione e policy prima di un nuovo invio autorizzato.';
  if (reason === 'ORDINARY_EMAIL_TRANSPORT_UNAVAILABLE') return 'Mittente o trasporto non disponibile. L’admin verifica la qualifica; nessun invio è attestato.';
  if (reason === 'RECONCILE_BEFORE_RETRY') return 'Tentativo già registrato senza esito certo. L’admin riconcilia la ricevuta nativa; il runner non ripete l’invio.';
  if (reason === 'WORKFLOW_SOURCE_CHANGED') return 'Evento, destinatario o assegnazione cambiati. Verificare la scheda e registrare il nuovo evento corretto.';
  if (reason === 'WORKFLOW_SERVICE_DENIED' || reason === 'WORKFLOW_SERVICE_DISABLED') return 'Delega o dati correnti non ammessi. L’admin verifica versione, permessi, scadenza e revoca; nessuna nuova trasmissione è autorizzata.';
  return 'Esecuzione sospesa. L’admin controlla il registro e le ricevute native prima di una nuova operazione.';
}
