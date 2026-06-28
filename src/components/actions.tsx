import Link from 'next/link';

const base = 'inline-flex items-center justify-center rounded-xl px-3 py-2 text-sm font-bold transition';
export function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} className={`${base} bg-fai-blue text-white hover:bg-fai-navy disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 ${props.className ?? ''}`} />; }
export function SecondaryLink({ href, children }: { href: string; children: React.ReactNode }) { return <Link className={`${base} border border-fai-blue/20 bg-white text-fai-blue hover:bg-fai-blue/10`} href={href}>{children}</Link>; }
export function OpenLink({ href, children = 'Apri' }: { href: string; children?: React.ReactNode }) { return <Link className="font-bold text-fai-blue underline" href={href}>{children}</Link>; }
export function DisabledAction({ children, reason = 'Funzione non ancora disponibile' }: { children: React.ReactNode; reason?: string }) { return <span className={`${base} cursor-not-allowed bg-slate-100 text-slate-500`} title={reason} aria-disabled="true">{children}<span className="sr-only"> — {reason}</span></span>; }
export function Hint({ children }: { children: React.ReactNode }) { return <p className="mt-2 text-xs text-fai-gray">{children}</p>; }
