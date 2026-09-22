import net from 'node:net';
import os from 'node:os';
import assert from 'node:assert/strict';

// Host-only access to the CI bridge: internal networks do not publish NAT ports.
assert.equal(process.env.CI, 'true');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.notEqual(os.hostname(), 'fai-crm-prod-02');
const [target, localText, remoteText] = process.argv.slice(2);
const localPort = Number(localText), remotePort = Number(remoteText);
assert.equal(net.isIP(target), 4);
assert.match(target, /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/);
assert.ok((localPort === 15432 && remotePort === 5432) || (localPort === 13000 && remotePort === 3000));
const sockets = new Set();
const server = net.createServer((client) => {
  const upstream = net.connect({ host: target, port: remotePort });
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { client.destroy(); upstream.destroy(); });
  }
  client.pipe(upstream).pipe(client);
});
server.listen(localPort, '127.0.0.1');
process.on('SIGTERM', () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
