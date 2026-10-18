export function DashboardIcon({ name, className }: { name: string; className?: string }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className}>
    {name === 'people' && <><circle cx="9" cy="7" r="3"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M16 4a3 3 0 0 1 0 6M18 14c3 0 4 3 4 7"/></>}
    {name === 'folder' && <><path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h7a2 2 0 0 1 2 2v2M2 9h20l-3 12H2Z"/></>}
    {name === 'document' && <><path d="M5 2h9l5 5v15H5Z"/><path d="M14 2v6h5M8 12h8M8 16h8M8 19h5"/></>}
    {name === 'calendar' && <><rect x="3" y="5" width="18" height="17" rx="2"/><path d="M7 2v6M17 2v6M3 11h18M7 15h2M14 15h2M7 18h2M14 18h2"/></>}
    {name === 'chart' && <><path d="M3 21V12h4v9M10 21V7h4v14M17 21V2h4v19"/></>}
    {name === 'gear' && <><path d="m9 2-1 3-3 1-2 3 2 3-1 3 3 3h3l2 3 3-1 1-3 3-1 2-3-2-3 1-3-3-3h-3l-2-2Z"/><circle cx="12" cy="11" r="3"/></>}
    {name === 'search' && <><circle cx="10" cy="10" r="7"/><path d="m15 15 7 7"/></>}
    {name === 'mail' && <><rect x="2" y="5" width="20" height="15" rx="2"/><path d="m3 6 9 8 9-8"/></>}
    {name === 'home' && <><path d="m2 11 10-9 10 9M5 9v13h5v-8h4v8h5V9"/></>}
    {name === 'video' && <><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m10 8 6 4-6 4Z"/></>}
    {name === 'user' && <><circle cx="12" cy="7" r="4"/><path d="M3 22v-3a9 9 0 0 1 18 0v3"/></>}
  </svg>;
}
