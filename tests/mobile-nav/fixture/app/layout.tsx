import "./fixture.css";

export default function FixtureLayout({ children }: { children: React.ReactNode }) {
  return <html lang="it" data-scroll-behavior="smooth"><body>{children}</body></html>;
}
