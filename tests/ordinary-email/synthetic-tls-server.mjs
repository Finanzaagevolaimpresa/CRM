import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import tls from 'node:tls';
assert.equal(process.env.CI, 'true');
assert.equal(process.env.ORDINARY_EMAIL_BROWSER_CONFIRMED, '1');
const password = process.env.DIRECT_EMAIL_TEST_SMTP_PASSWORD;
assert.ok(password && password.length >= 32);
const root = '/run/ordinary-control', evidence = process.env.ORDINARY_EMAIL_BROWSER_EVIDENCE;
const metrics = { synthetic: true, connections: 0, authenticated: 0, contents: [], tlsErrors: 0, protocolErrors: 0 };
let writing = Promise.resolve();
function persist() {
  const json = JSON.stringify(metrics);
  writing = writing.then(async () => {
    await writeFile(evidence + '/synthetic-smtp.json.tmp', json, { mode: 0o600 });
    await rename(evidence + '/synthetic-smtp.json.tmp', evidence + '/synthetic-smtp.json');
  });
  return writing;
}
const server = tls.createServer({
  key: await readFile('/run/ordinary-secrets/server.key'),
  cert: await readFile('/run/ordinary-secrets/server.crt'),
  minVersion: 'TLSv1.2',
}, socket => {
  metrics.connections++; void persist();
  let buffer = '', data = false, auth = false, from = '', recipients = [];
  let handling = Promise.resolve();
  socket.setEncoding('utf8'); socket.setTimeout(20_000, () => socket.destroy());
  socket.on('error', () => {}); socket.write('220 synthetic ordinary SMTP\r\n');
  socket.on('data', chunk => {
    handling = handling.then(async () => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) throw new Error('SYNTHETIC_SIZE');
      while (buffer.length) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const mime = buffer.slice(0, end + 2).replace(/(^|\r\n)\.\./g, '$1.');
          buffer = buffer.slice(end + 5); data = false;
          const mode = (await readFile(root + '/mode', 'utf8')).trim();
          metrics.contents.push({ from, recipients, sha256: createHash('sha256').update(mime, 'ascii').digest('hex'),
            bytes: Buffer.byteLength(mime, 'ascii'), bccHeader: /^bcc:/im.test(mime),
            servername: socket.servername, protocol: socket.getProtocol(), mode });
          await persist();
          if (mode === 'drop') { socket.destroy(); return; }
          socket.write('250 synthetic accepted\r\n'); continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (line.startsWith('EHLO ')) socket.write('250-synthetic\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH PLAIN ')) {
          assert.equal(Buffer.from(line.slice(11), 'base64').toString(), '\0comunicazioni@finanzaagevolaimpresa.it\0' + password);
          auth = true; metrics.authenticated++; await persist(); socket.write('235 synthetic authenticated\r\n');
        } else if (line.startsWith('MAIL FROM:')) {
          assert.ok(auth); assert.equal(line, 'MAIL FROM:<comunicazioni@finanzaagevolaimpresa.it>');
          from = 'comunicazioni@finanzaagevolaimpresa.it'; socket.write('250 synthetic sender\r\n');
        } else if (line.startsWith('RCPT TO:')) {
          const recipient = /^RCPT TO:<([^<>]+@invalid\.test)>$/.exec(line)?.[1];
          assert.ok(auth && from && recipient);
          const mode = (await readFile(root + '/mode', 'utf8')).trim();
          if (mode === 'reject') socket.write('550 synthetic refusal\r\n');
          else { recipients.push(recipient); socket.write('250 synthetic recipient\r\n'); }
        } else if (line === 'DATA') {
          assert.ok(auth && recipients.length); data = true; socket.write('354 synthetic content\r\n');
        } else if (line === 'QUIT') socket.end('221 synthetic closed\r\n');
        else throw new Error('SYNTHETIC_PROTOCOL');
      }
    }).catch(() => { metrics.protocolErrors++; void persist(); socket.destroy(); });
  });
});
server.on('tlsClientError', () => { metrics.tlsErrors++; void persist(); });
await persist();
await new Promise(resolve => server.listen(465, '0.0.0.0', resolve));
console.log('SYNTHETIC_SMTP_READY');
