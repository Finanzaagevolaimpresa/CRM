import Link from 'next/link';
import type { AuthSession } from '@/lib/auth';
import { adminOperationalLabels, type AdminOperationalModel, type AdminOperationalState } from '@/lib/admin-operational-state';
export function AdminOperationalShortcut({session,model,id,state}:{session:Pick<AuthSession,'role'>;model:AdminOperationalModel;id:string;state?:AdminOperationalState}){
  return <div className="my-2 space-y-1">{state&&<p>Stato amministrativo: <strong>{adminOperationalLabels[state]}</strong></p>}
    {session.role==='admin'&&<Link className="block font-semibold underline" href={'/admin/lifecycle/'+model+'/'+encodeURIComponent(id)}>Blocco, archivio e ripristino</Link>}
  </div>;
}
