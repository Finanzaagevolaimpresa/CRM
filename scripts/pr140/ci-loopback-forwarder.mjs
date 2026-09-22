import net from 'node:net';
import os from 'node:os';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// Host-only access to the CI bridge: internal networks do not publish NAT ports.
assert.equal(process.env.CI, 'true');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.notEqual(os.hostname(), 'fai-crm-prod-02');
const [target, localText, remoteText, keyPath, certPath] = process.argv.slice(2);
const localPort = Number(localText), remotePort = Number(remoteText);
assert.equal(net.isIP(target), 4);
assert.match(target, /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/);
assert.ok((localPort === 15432 && remotePort === 5432) || (localPort === 13000 && remotePort === 3000));
const sockets = new Set();
const tcpServer = () => net.createServer((client) => {
  const upstream = net.connect({ host: target, port: remotePort });
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { client.destroy(); upstream.destroy(); });
  }
  client.pipe(upstream).pipe(client);
});
let server;
if (localPort === 13000) {
  for (const file of [keyPath, certPath]) {
    assert.ok(file && process.env.RUNNER_TEMP);
    assert.equal(path.dirname(path.resolve(file)), path.resolve(process.env.RUNNER_TEMP));
  }
  server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (request, response) => {
    const upstream = http.request({ host: target, port: remotePort, method: request.method, path: request.url,
      headers: { ...request.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': request.headers.host } }, (incoming) => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('error', () => {
      if (response.headersSent) response.destroy();
      else { response.writeHead(502); response.end(); }
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
} else {
  assert.equal(keyPath, undefined);
  assert.equal(certPath, undefined);
  server = tcpServer();
}
server.listen(localPort, '127.0.0.1');
process.on('SIGTERM', () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
