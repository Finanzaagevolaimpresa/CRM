/** Notification pages are server-rendered: never inherit the server timezone. */
export function formatRecordNoticeTime(value?: Date | string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short',
  }).format(value instanceof Date ? value : new Date(value));
}
