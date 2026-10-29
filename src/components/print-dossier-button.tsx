'use client';
export function PrintDossierButton() {
  return <div data-print-control className="space-y-2"><button type="button" className="rounded-xl border px-4 py-2 font-bold" onClick={() => window.print()}>Stampa / salva PDF</button>
    <p className="text-sm">Nella finestra di stampa puoi scegliere “Salva come PDF”. Il browser crea il file; nessun documento viene inviato.</p></div>;
}

