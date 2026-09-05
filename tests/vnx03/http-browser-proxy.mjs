import http from 'node:http';

if (process.env.VNX03_BROWSER_PROXY_CONFIRMED !== '1') {
  throw new Error('VNX03_BROWSER_PROXY_CONFIRMATION_MISSING');
}

const allowedMethods = new Set(['GET', 'HEAD', 'POST']);
const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function filteredHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !hopByHopHeaders.has(name.toLowerCase())),
  );
}

const server = http.createServer((request, response) => {
  if (!request.method || !allowedMethods.has(request.method)) {
    response.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD, POST' });
    response.end('METHOD_NOT_ALLOWED');
    return;
  }
  if (!request.url || !request.url.startsWith('/') || request.url.startsWith('//')) {
    response.writeHead(400, { 'content-type': 'text/plain' });
    response.end('REQUEST_TARGET_INVALID');
    return;
  }

  const upstream = http.request({
    hostname: 'wordpress',
    port: 80,
    method: request.method,
    path: request.url,
    headers: filteredHeaders(request.headers),
  }, (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      filteredHeaders(upstreamResponse.headers),
    );
    upstreamResponse.pipe(response);
  });

  upstream.setTimeout(30_000, () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
    response.end('UPSTREAM_UNAVAILABLE');
  });
  request.pipe(upstream);
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
server.listen(8080, '0.0.0.0');
