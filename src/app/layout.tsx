import './globals.css';
import { Nav } from '@/components/ui';
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="it"><body><div className="flex"><Nav /><main className="min-h-screen flex-1 p-8">{children}</main></div></body></html>; }
