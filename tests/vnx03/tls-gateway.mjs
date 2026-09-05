import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

if (process.env.VNX03_TLS_GATEWAY_CONFIRMED !== '1') {
  throw new Error('VNX03_TLS_GATEWAY_CONFIRMATION_MISSING');
}

const secretRoot = '/run/vnx03-secrets';
const controlPath = '/run/vnx03-control/gateway-mode';
const evidencePath = '/run/vnx03-evidence/dropped-after-admission.marker';
const upstreamHost = process.env.VNX03_GATEWAY_UPSTREAM_HOST ?? 'crm';
const upstreamPort = Number(process.env.VNX03_GATEWAY_UPSTREAM_PORT ?? '3000');
const gatewayPath = '/api/integrations/website/leads/v2';
const maximumRequestBytes = 16 * 1024;
const maximumResponseBytes = 1024;

const [trustedKey, trustedCert, untrustedKey, untrustedCert] = await Promise.all([
  readFile(`${secretRoot}/gateway.trusted.key`),
  readFile(`${secretRoot}/gateway.trusted.crt`),
  readFile(`${secretRoot}/gateway.untrusted.key`),
  readFile(`${secretRoot}/gateway.untrusted.crt`),
]);
const trustedContext = tls.createSecureContext({ key: trustedKey, cert: trustedCert });
const untrustedContext = tls.createSecureContext({ key: untrustedKey, cert: untrustedCert });

async function gatewayMode() {
  const value = (await readFile(controlPath, 'utf8')).trim();
  if (value !== 'normal' && value !== 'drop_after_admission') {
    throw new Error('VNX03_GATEWAY_MODE_INVALID');
  }
  return value;
}

function collect(stream, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        reject(new Error('VNX03_PROXY_MESSAGE_TOO_LARGE'));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks, size)));
    stream.on('error', reject);
  });
}

function relayHeaders(source) {
  const output = {};
  for (const name of ['cache-control', 'content-type', 'pragma', 'retry-after']) {
    const value = source[name];
    if (typeof value === 'string') output[name] = value;
  }
  return output;
}

const server = https.createServer({
  key: trustedKey,
  cert: trustedCert,
  minVersion: 'TLSv1.2',
  SNICallback(servername, callback) {
    callback(
      null,
      servername === 'untrusted-gateway.vnx03.test' ? untrustedContext : trustedContext,
    );
  },
}, async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== gatewayPath) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"ok":false}');
      return;
    }
    const body = await collect(request, maximumRequestBytes);
    const headers = { ...request.headers, host: `${upstreamHost}:${upstreamPort}` };
    delete headers.connection;
    const upstreamResponse = await new Promise((resolve, reject) => {
      const upstream = http.request({
        host: upstreamHost,
        port: upstreamPort,
        method: 'POST',
        path: gatewayPath,
        headers,
      });
      upstream.on('response', resolve);
      upstream.on('error', reject);
      upstream.end(body);
    });
    const upstreamBody = await collect(upstreamResponse, maximumResponseBytes);
    if (await gatewayMode() === 'drop_after_admission' && upstreamResponse.statusCode === 202) {
      await writeFile(evidencePath, 'dropped_after_committed_202\n', { flag: 'wx', mode: 0o600 });
      request.socket.destroy();
      return;
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, relayHeaders(upstreamResponse.headers));
    response.end(upstreamBody);
  } catch {
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end('{"ok":false}');
    } else {
      response.destroy();
    }
  }
});

server.on('tlsClientError', () => undefined);
server.listen(8443, '0.0.0.0', () => {
  process.stdout.write('{"gateway":"ready","tls":"verified-client-side"}\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
