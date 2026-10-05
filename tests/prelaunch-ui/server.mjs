import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildFixture, output } from './build.mjs';
await buildFixture();
createServer(async (request, response) => {
  const name = new URL(request.url, 'http://127.0.0.1').pathname;
  const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] };
  if (!assets[name]) { response.writeHead(404); response.end(); return; }
  try { response.writeHead(200, { 'Content-Type': assets[name][1], 'Cache-Control': 'no-store' }); response.end(await readFile(join(output, assets[name][0]))); }
  catch { response.writeHead(500); response.end(); }
}).listen(3041, '127.0.0.1', () => console.log('PRELAUNCH_SYNTHETIC_UI_READY'));
