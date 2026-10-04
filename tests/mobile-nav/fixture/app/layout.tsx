import "./fixture.css";

export default function FixtureLayout({ children }: { children: React.ReactNode }) {
  return <html lang="it" data-scroll-behavior="smooth"><body><span data-testid="tooling-watch-probe" className="hidden text-[#112233]" aria-hidden="true">Sintetico</span>{children}</body></html>;
}
