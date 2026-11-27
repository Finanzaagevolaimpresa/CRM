import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer, type TLSSocket } from 'node:tls';
import type { WireOptions } from './ordinary-smtp-socket';

let certificate: Promise<{ key: Buffer; cert: Buffer }> | undefined;
async function certificateMaterial() {
  certificate ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fai-newsletter-tls-'));
    const executable = process.platform === 'win32' && existsSync('C:/Program Files/Git/mingw64/bin/openssl.exe')
      ? 'C:/Program Files/Git/mingw64/bin/openssl.exe' : 'openssl';
    const keyPath = join(directory, 'synthetic.key'), certPath = join(directory, 'synthetic.crt');
    execFileSync(executable, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=authsmtp.securemail.pro',
      '-addext', 'subjectAltName=DNS:authsmtp.securemail.pro', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', timeout: 10_000 });
    return { key: await readFile(keyPath), cert: await readFile(certPath) };
  })();
  return certificate;
}
export type NewsletterTlsWire = WireOptions & { beforeReply?: (command: string) => Promise<void> };

/** Real TLS handshake and SMTP framing on an ephemeral loopback port only.
 * The native connector still supplies the approved hostname, TLS version and
 * rejection policy; this fixture replaces only routing/CA with synthetic ones. */
export async function newsletterTlsPeer(wire: NewsletterTlsWire = {}) {
  const material = await certificateMaterial(), live = new Set<TLSSocket>();
  const sockets: Array<{ writes: string[]; protocol: string | null; servername: string }> = [];
  const server = createServer({ ...material, minVersion: 'TLSv1.2' }, socket => {
    live.add(socket); socket.on('close', () => live.delete(socket)); socket.on('error', () => {});
    const observed = { writes: [] as string[], protocol: socket.getProtocol(), servername: (socket as TLSSocket & { servername: string }).servername };
    sockets.push(observed); socket.setEncoding('utf8'); socket.setTimeout(15_000, () => socket.destroy());
    socket.write('220 synthetic loopback SMTP\r\n');
    let buffer = '', content = false, work = Promise.resolve();
    socket.on('data', chunk => {
      work = work.then(async () => {
        buffer += chunk;
        if (buffer.length > 1_000_000) throw new Error('SYNTHETIC_SMTP_SIZE');
        while (buffer.length) {
          if (content) {
            const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return;
            const mime = buffer.slice(0, end + 5); observed.writes.push(mime); buffer = buffer.slice(end + 5); content = false;
            if (wire.final === null) { socket.destroy(); return; }
            socket.write(wire.final ?? '250 synthetic accepted\r\n'); continue;
          }
          const end = buffer.indexOf('\r\n'); if (end < 0) return;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); observed.writes.push(line + '\r\n');
          wire.onWrite?.(line + '\r\n'); await wire.beforeReply?.(line);
          if (line.startsWith('EHLO ')) socket.write('250-synthetic\r\n250 AUTH PLAIN\r\n');
          else if (line.startsWith('AUTH PLAIN ')) socket.write('235 synthetic authenticated\r\n');
          else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write('250 synthetic admitted\r\n');
          else if (line === 'DATA') { content = true; await wire.beforeDataReply?.(); socket.write('354 synthetic continue\r\n'); }
          else if (line === 'QUIT') { socket.end('221 synthetic closed\r\n'); return; }
          else throw new Error('SYNTHETIC_SMTP_PROTOCOL');
        }
      }).catch(() => { socket.destroy(); });
    });
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const connectTls: typeof connect = ((options: Parameters<typeof connect>[0]) => {
    const selected = options as import('node:tls').ConnectionOptions;
    assert.equal(selected.host, 'authsmtp.securemail.pro'); assert.equal(selected.port, 465);
    assert.equal(selected.servername, 'authsmtp.securemail.pro'); assert.equal(selected.rejectUnauthorized, true);
    return connect({ ...selected, host: '127.0.0.1', port: address.port, ca: material.cert });
  }) as typeof connect;
  return { sockets, connectTls, close: async () => {
    for (const socket of live) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
