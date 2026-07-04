"use client";

import { useState } from "react";

export function SidebarLogo() {
  const [hasLogoError, setHasLogoError] = useState(false);

  return (
    <span className="flex h-16 w-24 shrink-0 items-center justify-center rounded-2xl bg-white p-2 ring-1 ring-slate-200">
      {hasLogoError ? (
        <span className="text-lg font-black tracking-[0.18em] text-fai-navy">
          FAI
        </span>
      ) : (
        <img
          alt="Logo Finanza Agevola Impresa"
          className="h-12 max-h-full w-full max-w-full object-contain"
          onError={() => setHasLogoError(true)}
          src="/logo-fai.png"
        />
      )}
    </span>
  );
}
