import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export const output = resolve('artifacts/prelaunch-ui');
export async function buildFixture() {
  await mkdir(output, { recursive: true });
  await build({ entryPoints: ['tests/prelaunch-ui/fixture.tsx'], bundle: true, platform: 'browser', jsx: 'automatic',
    outfile: resolve(output, 'app.js'), define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' } });
  const from = resolve('src/app/globals.css');
  const css = await postcss([tailwind({ base: process.cwd() })]).process(await readFile(from, 'utf8'), { from });
  await writeFile(resolve(output, 'app.css'), css.css);
  await writeFile(resolve(output, 'index.html'), '<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PRELANCIO-01 · componente candidato</title><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>');
}
