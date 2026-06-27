import { demoAdminLoginAction, loginAction } from '@/lib/login-actions';

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const isDevelopment = process.env.APP_ENV === 'development';
  const message = error === 'invalid'
    ? 'Email o password non validi.'
    : error === 'demo-unavailable'
      ? 'Utente admin demo non disponibile: eseguire il seed del database.'
      : null;

  return (
    <div className="mx-auto mt-20 max-w-md rounded-xl bg-white p-8 shadow">
      <h1 className="text-2xl font-bold text-fai-blue">Accesso interno FAI</h1>
      <p className="mt-3 text-sm text-fai-gray">
        Accesso riservato agli utenti interni del CRM FAI. La sessione viene salvata in un cookie firmato con scadenza.
      </p>

      {message ? <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p> : null}

      <form action={loginAction} className="mt-6 space-y-4">
        <label className="block text-sm font-medium text-fai-navy">
          Email
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-fai-blue focus:ring-2 focus:ring-fai-blue/20"
            name="email"
            type="email"
            autoComplete="username"
            required
          />
        </label>
        <label className="block text-sm font-medium text-fai-navy">
          Password
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-fai-blue focus:ring-2 focus:ring-fai-blue/20"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button className="w-full rounded-lg bg-fai-blue px-4 py-2 font-semibold text-white hover:bg-fai-navy" type="submit">
          Login interno
        </button>
      </form>

      {isDevelopment ? (
        <form action={demoAdminLoginAction} className="mt-3">
          <button className="w-full rounded-lg border border-fai-blue px-4 py-2 font-semibold text-fai-blue hover:bg-blue-50" type="submit">
            Accedi come admin demo
          </button>
        </form>
      ) : null}
    </div>
  );
}
