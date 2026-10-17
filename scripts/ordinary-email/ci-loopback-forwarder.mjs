import net from 'node:net';
import os from 'node:os';
import assert from 'node:assert/strict';

// Same host-only bridge pattern as PR140, fixed to this synthetic browser port.
assert.equal(process.env.CI, 'true');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.ORDINARY_EMAIL_BROWSER_CONFIRMED, '1');
assert.equal(process.env.APP_ENV, 'test');
assert.notEqual(os.hostname(), 'fai-crm-prod-02');
const [target, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
assert.equal(net.isIP(target), 4);
assert.match(target, /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/);
const sockets = new Set();
const server = net.createServer((client) => {
  const upstream = net.connect({ host: target, port: 3036 });
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { client.destroy(); upstream.destroy(); });
  }
  client.pipe(upstream).pipe(client);
});
server.listen(3036, '127.0.0.1');
process.on('SIGTERM', () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
