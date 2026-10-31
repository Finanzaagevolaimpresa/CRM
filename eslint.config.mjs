import { defineConfig, globalIgnores } from "eslint/config";
import { installLegacyMinimatchCall } from "./scripts/lint-minimatch-compat.mjs";

// Legacy lint plugins still call the CommonJS export. All matching is performed
// by the patched minimatch release; no vulnerable matcher is retained.
installLegacyMinimatchCall();
const { default: nextVitals } = await import("eslint-config-next/core-web-vitals");
const { default: nextTypeScript } = await import("eslint-config-next/typescript");

import { guardNextConfigs } from "./scripts/next-glob-guard.mjs";

export default defineConfig([
  ...guardNextConfigs([
  ...nextVitals,
  ...nextTypeScript,
  ]),
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "artifacts/prelaunch-ui/**",
    "next-env.d.ts",
  ]),
]);
