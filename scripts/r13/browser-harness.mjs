import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Test-only: loopback, memory fixtures and .invalid recipients. No environment,
// credential, database, application server or provider configuration is loaded.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(repository, '.next', `r13-browser-${Date.now()}`);
mkdirSync(output, { recursive: true });
const require = createRequire(import.meta.url);
const inputs = [
  'tests/fixtures/r13-marketing-store.ts',
  'src/components/marketing-withdrawal-form.tsx',
  'src/lib/marketing-preferences/withdrawal-http.ts',
  'tests/fixtures/r13-marketing-browser.tsx',
];
const compilation = spawnSync(process.execPath, [
  resolve(repository, 'node_modules/typescript/bin/tsc'), '--outDir', output,
  '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'ES2022',
  '--jsx', 'react-jsx', '--esModuleInterop', '--skipLibCheck', '--strict',
  '--noEmit', 'false', ...inputs,
], { cwd: repository, stdio: 'inherit', shell: false });
if (compilation.error) throw compilation.error;
if (compilation.status !== 0) process.exit(compilation.status ?? 1);
let clientAvailable = false;
let clientBuildError = null;
let clientBundler = null;
{
  try {
    const bundled = require('next/dist/compiled/webpack/webpack');
    const webpack = bundled.webpack;
    await new Promise((resolveBuild, rejectBuild) => {
      const compiler = webpack({
        context: repository, mode: 'development', target: 'web', devtool: false,
        entry: resolve(output, 'tests/fixtures/r13-marketing-browser.js'),
        output: { path: output, filename: 'client.js' },
        resolve: { modules: [resolve(repository, 'node_modules')], symlinks: false },
        optimization: { minimize: false }, cache: false,
      });
      compiler.run((error, stats) => compiler.close(closeError => {
        if (error || closeError) rejectBuild(error ?? closeError);
        else if (stats.hasErrors()) rejectBuild(new Error(stats.toString({ all: false, errors: true })));
        else resolveBuild();
      }));
    });
    clientAvailable = true;
    clientBundler = `webpack-${webpack.version}`;
  } catch (error) {
    clientBuildError = error instanceof Error ? error.message : 'CLIENT_BUILD_FAILED';
    console.error('Interactive build unavailable; native HTML cases remain executable.');
  }
}
const { createElement } = require('react');
const { renderToString } = require('react-dom/server');
const { MarketingWithdrawalForm } = require(resolve(output, 'src/components/marketing-withdrawal-form.js'));
const { createWithdrawalPost } = require(resolve(output, 'src/lib/marketing-preferences/withdrawal-http.js'));
const { MarketingPreferences } = require(resolve(output, 'src/lib/marketing-preferences/service.js'));
const { MemoryPreferenceStore, SYNTHETIC_KEY, SYNTHETIC_NOTICE, readiness, choice, id } =
  require(resolve(output, 'tests/fixtures/r13-marketing-store.js'));
const definitions = [
  ['native-known', 'HTML nativo: contatto sintetico con consenso', false, true],
  ['native-unknown', 'HTML nativo: contatto sintetico sconosciuto', false, false],
  ['native-failure', 'HTML nativo: errore di persistenza', false, true],
  ['native-replay', 'HTML nativo: ripetizione della stessa richiesta', false, true],
  ['enhanced-known', 'React interattivo: conferma e nuova richiesta', true, true],
  ['enhanced-retry', 'React interattivo: errore e ripetizione', true, true],
];
const cases = new Map();
for (const [name, label, enhanced, known] of definitions) {
  const store = new MemoryPreferenceStore();
  const service = new MarketingPreferences(store, SYNTHETIC_KEY,
    async () => ({ ...readiness(), checkedAt: store.clock }));
  if (known) {
    store.choices.set(id(1), choice());
    await service.recordChoice(id(1), SYNTHETIC_NOTICE);
  }
  const grantBytes = JSON.stringify([...store.rows.values()].flatMap(row => row.events));
  cases.set(name, { name, label, enhanced, known, store, service, grantBytes,
    submissions: 0, replayId: randomUUID(), handler: null });
}
const digest = value => createHash('sha256').update(value).digest('hex');
const sourcePaths = [...inputs,
  'src/lib/marketing-preferences/service.ts', 'src/lib/marketing-preferences/policy.ts',
  'scripts/r13/browser-harness.mjs'];
const evidence = { protocol: 'R13_SYNTHETIC_REAL_BROWSER_HARNESS',
  startedUtc: new Date().toISOString(), stoppedUtc: null,
  databaseUsed: false, realRecipientsAllowed: false, providerUsed: false,
  clientAvailable, clientBuildError, clientBundler,
  sources: sourcePaths.map(path => ({ path, sha256: digest(readFileSync(resolve(repository, path))) })),
  runtime: { node: process.version, react: require('react/package.json').version,
    typescript: require('typescript/package.json').version, webpack: clientBundler },
  visits: [], submissions: [] };
const auditPath = resolve(output, 'browser-audit.json');
const save = () => writeFileSync(auditPath, JSON.stringify(evidence, null, 2) + '\n');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const header = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };
const page = (title, content, script = '') => `<!doctype html><html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escape(title)} — collaudo locale R13</title>
<style>body{font:18px system-ui;line-height:1.5;margin:40px auto;max-width:820px;padding:0 20px;color:#17263b}h1,h2{color:#043e8a}label,input,button{display:block;margin:12px 0}input{font:inherit;padding:10px;width:min(90%,500px)}button{font:inherit;padding:12px;background:#043e8a;color:white;border:0;border-radius:5px}button:disabled{opacity:.6}.fixture{padding:14px;border-left:4px solid #80cc2a;background:#f4f7fb}a{color:#043e8a}li{margin:10px 0}</style>
</head><body><main>${content}</main>${script}</body></html>`;
let origin;
const server = createServer(async (request, response) => {
  try {
    if (request.headers.host !== new URL(origin).host) {
      response.writeHead(403, header).end('Host del banco non ammesso.'); return;
    }
    const url = new URL(request.url, origin);
    if (request.method === 'GET' && url.pathname === '/client.js' && clientAvailable) {
      response.writeHead(200, { ...header, 'content-type': 'text/javascript; charset=utf-8' });
      response.end(readFileSync(resolve(output, 'client.js'))); return;
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/preferenze-email/')) {
      response.writeHead(200, header).end(page('Banco sintetico', `<h1>Collaudo browser R13</h1>
<p class="fixture">Solo memoria locale e indirizzi .invalid. Nessun CRM, database, sito o invio reale.</p>
<p>Le pagine HTML native non caricano JavaScript. Le pagine React usano il componente effettivo.</p>
<ul>${definitions.map(([name, label, enhanced]) => `<li>${enhanced && !clientAvailable
  ? `${escape(label)} — compilazione JavaScript non disponibile`
  : `<a href="/case/${name}">${escape(label)}</a>`}</li>`).join('')}</ul>`)); return;
    }
    const match = /^\/case\/([a-z-]+)(\/submit)?$/.exec(url.pathname);
    const testCase = match && cases.get(match[1]);
    if (!testCase) { response.writeHead(404, header).end('Caso non trovato.'); return; }
    if (testCase.enhanced && !clientAvailable) {
      response.writeHead(503, header).end('Collaudo JavaScript non disponibile in questo avvio.'); return;
    }
    if (request.method === 'GET' && !match[2]) {
      const requestId = testCase.name === 'native-replay' ? testCase.replayId : randomUUID();
      const endpoint = `/case/${testCase.name}/submit`;
      evidence.visits.push({ case: testCase.name, enhanced: testCase.enhanced,
        requestId, renderedUtc: new Date().toISOString() }); save();
      const form = renderToString(createElement(MarketingWithdrawalForm, { endpoint, requestId }));
      response.writeHead(200, { ...header, 'content-security-policy':
        `default-src 'none'; style-src 'unsafe-inline'; script-src ${testCase.enhanced ? "'self'" : "'none'"}; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` });
      response.end(page(testCase.label, `<p class="fixture">Banco locale sintetico — ${escape(testCase.label)}. Usare solo recipient@r13.invalid oppure new@r13.invalid.</p>
<div id="r13-browser-fixture" data-endpoint="${endpoint}" data-request-id="${requestId}">${form}</div>
<p><a href="/">Torna ai casi di collaudo</a></p>`, testCase.enhanced ? '<script src="/client.js" defer></script>' : '')); return;
    }
    if (request.method !== 'POST' || !match[2]) {
      response.writeHead(405, header).end('Metodo non ammesso.'); return;
    }
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2048) { response.writeHead(413, header).end('Corpo non ammesso.'); return; }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const type = String(request.headers['content-type'] ?? '').split(';')[0];
    let input;
    try { input = type === 'application/json' ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)); }
    catch { response.writeHead(400, header).end('Input sintetico richiesto.'); return; }
    if (!['recipient@r13.invalid', 'new@r13.invalid'].includes(input.email)) {
      response.writeHead(400, header).end('Il banco ammette solo i due indirizzi sintetici dichiarati.'); return;
    }
    const rows = () => [...testCase.store.rows.values()].flatMap(row => row.events);
    const before = rows();
    testCase.submissions += 1;
    testCase.store.clock = new Date(Date.parse('2026-09-28T10:00:00.000Z') + testCase.submissions * 1000).toISOString();
    testCase.store.failCommit = testCase.name === 'native-failure'
      || (testCase.name === 'enhanced-retry' && testCase.submissions === 1);
    let commitHookCompletedUtc = null;
    testCase.store.beforeCommit = async () => {
      if (testCase.enhanced) await new Promise(resolveDelay => setTimeout(resolveDelay, 1500));
      commitHookCompletedUtc = new Date().toISOString();
    };
    const startedUtc = new Date().toISOString();
    const actual = await testCase.handler(new Request(url, {
      method: 'POST', headers: request.headers, body,
    }));
    const completedUtc = new Date().toISOString();
    const responseBody = await actual.text();
    const after = rows();
    evidence.submissions.push({ case: testCase.name, ordinal: testCase.submissions,
      requestId: input.requestId, format: type, originChecked: request.headers.origin === origin,
      observedOrigin: request.headers.origin ?? null,
      httpStatus: actual.status, startedUtc, commitHookCompletedUtc, completedUtc,
      eventsBefore: before.length, eventsAfter: after.length,
      grantPreserved: JSON.stringify(after.filter(row => row.kind === 'GRANTED')) === testCase.grantBytes,
      suppressionEvents: after.filter(row => row.kind === 'SUPPRESSED').map(row => ({
        eventId: row.eventId, occurredAt: row.occurredAt, recordedAt: row.recordedAt })),
      responseSha256: digest(responseBody), responseContainsEmail: /(?:recipient|new)@r13\.invalid/.test(responseBody),
      confirmationReturned: responseBody.includes('Richiesta registrata.'),
    }); save();
    response.writeHead(actual.status, Object.fromEntries(actual.headers)); response.end(responseBody);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'HARNESS_FAILURE');
    if (!response.headersSent) response.writeHead(500, header);
    response.end('Errore del banco locale, nessun esito qualificato.');
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
origin = `http://127.0.0.1:${server.address().port}`;
for (const testCase of cases.values()) testCase.handler = createWithdrawalPost({
  service: testCase.service, publicOrigin: origin,
  // Only a fixed local fixture: explicitly not a qualified production limiter.
  admitRequest: async () => true,
});
evidence.origin = origin; save();
console.log(JSON.stringify({ origin, auditPath, output, syntheticOnly: true, clientAvailable }));
const stop = () => {
  evidence.stoppedUtc = new Date().toISOString(); save();
  server.close(() => process.exit(0)); server.closeAllConnections();
};
process.once('SIGINT', stop); process.once('SIGTERM', stop);
