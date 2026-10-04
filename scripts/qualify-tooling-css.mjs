import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, 'node_modules/.cache/tooling-r106/evidence');
const baseline = join(root, 'node_modules/.cache/tooling-r106/baseline');
mkdirSync(evidence, { recursive: true });
const require = createRequire(join(root, 'package.json'));
const beforeRequire = createRequire(join(baseline, 'package.json'));
assert.equal(beforeRequire('tailwindcss/package.json').version, '3.4.19');
assert.equal(require('tailwindcss/package.json').version, '4.3.3');

const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<main class="mx-auto max-w-3xl space-y-4 p-6 text-sm text-gray-900">
<header data-probe class="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"><h1 data-probe class="text-2xl font-bold text-fai-blue">CRM sintetico</h1><p class="mt-2 text-gray-600">Anagrafica, documenti e avanzamento</p></header>
<section data-probe class="grid grid-cols-1 gap-4 md:grid-cols-3"><div data-probe class="rounded-xl bg-fai-navy p-4 text-white"><span class="font-mono text-3xl tabular-nums">123</span><p class="text-xs">Contatore</p></div><div data-probe class="rounded-xl bg-fai-green p-4 text-white">Stato verificato</div><div data-probe class="rounded-xl bg-fai-lime/20 p-4 text-fai-navy">Avanzamento</div></section>
<section data-probe class="space-y-3 rounded-xl border bg-white p-4"><label class="block font-semibold">Dato sintetico<input data-probe class="mt-2 block w-full rounded-lg border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-fai-lime" value="Esempio"></label><button data-probe class="rounded-xl bg-fai-blue px-4 py-2 text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-fai-lime">Azione</button><button data-probe disabled class="ml-3 rounded-xl bg-gray-200 px-4 py-2 text-gray-500 disabled:cursor-not-allowed disabled:opacity-50">Disabilitato</button></section>
<section data-probe class="space-y-3"><div data-probe class="rounded bg-white p-3">Uno</div><div hidden>Non visibile</div><div data-probe class="rounded bg-white p-3">Due</div></section>
<section data-probe class="divide-y divide-gray-200 rounded-xl bg-white"><p data-probe class="p-3">Riga uno</p><p data-probe class="p-3">Riga due</p></section>
<section data-probe class="rounded-2xl bg-gradient-to-r from-fai-blue to-fai-green p-4 text-white">Gradiente FAI</section>
<nav data-probe class="sticky top-0 z-40 rounded-xl border border-gray-200 bg-white/95 p-3 shadow-sm"><span class="md:hidden">Menu mobile</span><span class="hidden md:inline">Navigazione desktop</span></nav>
<section class="grid grid-cols-2 gap-4 p-3"><div data-probe class="rounded-xl bg-white p-3 ring-1 ring-inset ring-fai-blue">Bordo interno</div><div data-probe class="rounded-xl bg-white p-3 ring-2 ring-fai-lime ring-offset-2">Bordo distanziato</div></section>
</main></body></html>`;
const migrated = fixture.replaceAll('shadow-sm', 'shadow-xs').replaceAll('outline-none', 'outline-compat').replaceAll('bg-gradient-to-r', 'bg-linear-to-r/srgb')
  .replace(/\bspace-y-(\d+(?:\.\d+)?)/g, 'crm-space-y-$1').replaceAll('divide-y', 'crm-divide-y').replaceAll('divide-gray-', 'crm-divide-gray-');
const config = beforeRequire('tailwindcss/loadConfig')(join(baseline, 'tailwind.config.ts'));
config.content = [{ raw: fixture, extension: 'html' }];
const beforeCss = (await beforeRequire('postcss')([beforeRequire('tailwindcss')(config), beforeRequire('autoprefixer')()]).process(readFileSync(join(baseline, 'src/app/globals.css'), 'utf8'), { from: join(baseline, 'src/app/globals.css') })).css;
const tokens = [...new Set([...migrated.matchAll(/class="([^"]+)"/g)].flatMap(match => match[1].split(/\s+/)))];
const source = readFileSync(join(root, 'src/app/globals.css'), 'utf8') + `\n@source inline("${tokens.join(' ')}");\n`;
const afterCss = (await require('postcss')([require('@tailwindcss/postcss')()]).process(source, { from: join(root, 'src/app/globals.css') })).css;
writeFileSync(join(evidence, 'baseline.css'), beforeCss);
writeFileSync(join(evidence, 'candidate.css'), afterCss);

async function describe(page) {
  return page.locator('[data-probe]').evaluateAll(elements => {
    // CSS Color 4 can serialize identical sRGB colors as rgba() or oklab().
    // Compare their rendered bytes, while independently retaining pixel checks.
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    const colorBytes = value => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].join(',');
    };
    return elements.map(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      rect: [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value * 100) / 100),
      style: Object.fromEntries(['display', 'color', 'backgroundColor', 'fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'borderTopWidth', 'borderTopColor', 'borderRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'opacity', 'cursor', 'outlineStyle', 'outlineWidth', 'outlineOffset'].map(name => [name, ['color', 'backgroundColor', 'borderTopColor'].includes(name) ? colorBytes(style[name]) : style[name]])),
    };
    });
  });
}

async function comparePixels(page, first, second) {
  return page.evaluate(async ([a, b]) => {
    async function pixels(base64) {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
    }
    const left = await pixels(a); const right = await pixels(b);
    if (left.width !== right.width || left.height !== right.height) return { dimensionsDiffer: true, dimensions: [[left.width, left.height], [right.width, right.height]] };
    let changed = 0; let maximum = 0;
    const changedSamples = [];
    let xMin = left.width; let yMin = left.height; let xMax = -1; let yMax = -1;
    for (let i = 0; i < left.data.length; i += 4) {
      let delta = 0; for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(left.data[i + c] - right.data[i + c]));
      maximum = Math.max(maximum, delta);
      if (delta > 4) {
        changed++;
        const x = (i / 4) % left.width; const y = Math.floor(i / 4 / left.width);
        xMin = Math.min(xMin, x); yMin = Math.min(yMin, y); xMax = Math.max(xMax, x); yMax = Math.max(yMax, y);
        if (changedSamples.length < 30) changedSamples.push({ x, y, before: [...left.data.slice(i, i + 4)], after: [...right.data.slice(i, i + 4)] });
      }
    }
    return { changedPixelsAboveFour: changed, maximumChannelDelta: maximum, totalPixels: left.width * left.height,
      changedBounds: changed ? [xMin, yMin, xMax, yMax] : null, changedSamples };
  }, [first.toString('base64'), second.toString('base64')]);
}

const report = { baselineVersion: '3.4.19', candidateVersion: '4.3.3', cssSha256: [beforeCss, afterCss].map(css => createHash('sha256').update(css).digest('hex')), cases: [] };
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch();
    try {
      for (const width of [390, 767, 768, 1280]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light' });
        try {
          const left = await context.newPage(); const right = await context.newPage();
          await left.setContent(fixture); await left.addStyleTag({ content: beforeCss });
          await right.setContent(migrated); await right.addStyleTag({ content: afterCss });
          await left.locator('input').focus(); await right.locator('input').focus();
          // Measure settled focus styles, not arbitrary points in the real 160ms transition.
          await Promise.all([left, right].map(page => page.evaluate(async () => {
            await new Promise(resolve => requestAnimationFrame(resolve));
            await Promise.all(document.getAnimations().map(animation => animation.finished));
          })));
          const descriptions = [await describe(left), await describe(right)];
          const first = await left.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
          const second = await right.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
          const pixels = await comparePixels(right, first, second);
          if (pixels.changedPixelsAboveFour > 0) {
            const effects = await Promise.all([left, right].map(page => page.locator('[data-probe]').evaluateAll(elements => elements.map((element, index) => {
              const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
              return { probe: index, rect: [rect.x, rect.y, rect.width, rect.height], boxShadow: style.boxShadow, backgroundImage: style.backgroundImage };
            }))));
            console.log(JSON.stringify({ engine: name, width, effectDifferences: effects[0].flatMap((effect, index) => JSON.stringify(effect) === JSON.stringify(effects[1][index]) ? [] : [{ before: effect, after: effects[1][index] }]) }));
          }
          const entry = { engine: name, width, computedStylesEqual: JSON.stringify(descriptions[0]) === JSON.stringify(descriptions[1]), pixels };
          report.cases.push(entry);
          writeFileSync(join(evidence, `${name}-${width}-before.png`), first);
          writeFileSync(join(evidence, `${name}-${width}-after.png`), second);
          if (!entry.computedStylesEqual) writeFileSync(join(evidence, `${name}-${width}-differences.json`), JSON.stringify(descriptions, null, 2));
          const differences = descriptions[0].flatMap((item, index) => {
            const other = descriptions[1][index];
            const changes = {};
            if (JSON.stringify(item.rect) !== JSON.stringify(other.rect)) changes.rect = [item.rect, other.rect];
            for (const key of Object.keys(item.style)) if (item.style[key] !== other.style[key]) changes[key] = [item.style[key], other.style[key]];
            return Object.keys(changes).length ? [{ probe: index, changes }] : [];
          });
          console.log(JSON.stringify({ ...entry, differences: differences.slice(0, 12) }));
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
} finally { writeFileSync(join(evidence, 'compatibility.json'), JSON.stringify(report, null, 2) + '\n'); }
assert.equal(report.cases.length, 12);
assert.ok(report.cases.every(item => item.computedStylesEqual && !item.pixels.dimensionsDiffer && item.pixels.changedPixelsAboveFour === 0), 'Tailwind migration changes the synthetic UI; inspect the retained before/after evidence.');
console.log('CSS_COMPATIBILITY_PASS: 12 browser/viewport comparisons; matching computed layout and no pixel differences above four channel levels.');
