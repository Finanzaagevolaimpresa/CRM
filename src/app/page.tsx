import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { redirect } from 'next/navigation';
  function Home(){ redirect('/dashboard'); }

export default withTechnicalPage("/", Home);
