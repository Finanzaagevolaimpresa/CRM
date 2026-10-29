import Link from 'next/link';
import type { AuthSession } from '@/lib/auth';
import { adminRecordPolicy } from '@/lib/admin-record-catalogue';
import { recordUpdatePermission } from '@/lib/record-update-context';
export function AdminRecordShortcut({ session, model, id }: { session: AuthSession; model: string; id?: string }) {
  const policy = adminRecordPolicy(model);
  if (session.role !== 'admin' || !recordUpdatePermission(session, policy.permission)) return null;
  return <Link className="inline-block rounded-xl border px-4 py-2 font-semibold text-fai-blue underline"
    href={`/admin/records/${model}${id ? '/' + encodeURIComponent(id) : ''}`}>Controllo Admin · {policy.label}</Link>;
}
