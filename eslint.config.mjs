import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

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
    "next-env.d.ts",
  ]),
]);
