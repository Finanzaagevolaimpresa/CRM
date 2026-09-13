"use client";

import Image from "next/image";
import { useState } from "react";
import officialLogo from "../../public/logo-fai.png";

export function SidebarLogo({ compact = false }: { compact?: boolean }) {
  const [hasLogoError, setHasLogoError] = useState(false);

  return (
    <span className={`flex shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-slate-200 ${compact ? "h-12 w-24 p-1.5" : "h-20 w-full p-3"}`}>
      {hasLogoError ? (
        <span role="img" aria-label="Logo Finanza Agevola Impresa non disponibile" className="text-center text-xs font-bold text-slate-500">
          Logo non disponibile
        </span>
      ) : (
        <Image
          alt="Finanza Agevola Impresa"
          className="h-full w-full object-contain"
          height={567}
          onError={() => setHasLogoError(true)}
          priority
          src={officialLogo}
          width={971}
        />
      )}
    </span>
  );
}
