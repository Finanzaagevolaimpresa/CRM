'use client';

import { useFormStatus } from 'react-dom';
type Message = { from: string; replyTo: string; to: string; subject: string; body: string };
function Submit() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="rounded-xl bg-fai-blue px-4 py-3 font-bold text-white disabled:opacity-50">
    {pending ? 'Verifica del tentativo in corso…' : 'Invia test approvato'}
  </button>;
}
export function DirectEmailTestForm({ token, message, action }: {
  token: string; message: Message; action: (form: FormData) => Promise<void>;
}) {
  return <form action={action} className="crm-space-y-4">
    <dl className="crm-space-y-2 break-words rounded-xl border p-4">
      <div><dt className="font-bold">Da / Rispondi a</dt><dd>{message.from} / {message.replyTo}</dd></div>
      <div><dt className="font-bold">Destinatario controllato</dt><dd>{message.to}</dd></div>
      <div><dt className="font-bold">Oggetto</dt><dd>{message.subject}</dd></div>
      <div><dt className="font-bold">Messaggio</dt><dd>{message.body}</dd></div>
    </dl>
    <p>Questa azione invia una sola email tecnica. Non include allegati o dati cliente.</p>
    <input type="hidden" name="previewToken" value={token} />
    <label className="flex items-start gap-3"><input className="mt-1" type="checkbox" name="exactApproval" value="APPROVO_IL_MESSAGGIO_ESATTO" required />
      Approvo mittente, destinatario, oggetto e testo esatti mostrati qui e autorizzo questo singolo test.</label>
    <Submit />
  </form>;
}
