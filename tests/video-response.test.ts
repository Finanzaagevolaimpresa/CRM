import assert from 'node:assert/strict';
import test from 'node:test';
import { privateVideoResponse } from '../src/lib/video-response';

const video = { bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), mimeType: 'video/mp4' as const, fileName: 'Formazione tecnica.mp4' };
const request = (method = 'GET', range?: string, suffix = '') => new Request('https://crm.invalid.test/videos/synthetic/content' + suffix,
  { method, headers: range ? { Range: range } : {} });
test('an unauthorized GET, HEAD, range and download disclose neither length nor content type', async () => {
  for (const req of [request(), request('HEAD'), request('GET', 'bytes=999-'), request('GET', undefined, '?download=1')]) {
    const response = await privateVideoResponse(req, async () => null);
    assert.equal(response.status, 404); assert.equal((await response.arrayBuffer()).byteLength, 0);
    for (const name of ['Content-Length', 'Content-Range', 'Content-Type', 'Content-Disposition']) assert.equal(response.headers.get(name), null);
    assert.match(response.headers.get('Cache-Control')!, /no-store/);
  }
});
test('fresh authorization is required on every range; revocation stops the next player request', async () => {
  let allowed = true, checks = 0;
  const authorize = async () => { checks++; return allowed ? video : null; };
  const first = await privateVideoResponse(request('GET', 'bytes=0-2'), authorize);
  assert.equal(first.status, 206); assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [0, 1, 2]);
  assert.equal(first.headers.get('Content-Range'), 'bytes 0-2/8');
  allowed = false;
  assert.equal((await privateVideoResponse(request('GET', 'bytes=3-7'), authorize)).status, 404);
  assert.equal(checks, 2);
});
test('HEAD and GET describe the same allowed suffix while HEAD returns no bytes', async () => {
  const head = await privateVideoResponse(request('HEAD', 'bytes=-3'), async () => video);
  const get = await privateVideoResponse(request('GET', 'bytes=-3'), async () => video);
  assert.equal(head.status, 206); assert.equal(head.headers.get('Content-Length'), '3');
  assert.deepEqual([...head.headers], [...get.headers]); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.deepEqual([...new Uint8Array(await get.arrayBuffer())], [5, 6, 7]);
});
test('range errors disclose size only after admission; public caching and conditional reuse stay disabled', async () => {
  const response = await privateVideoResponse(request('GET', 'bytes=30-40'), async () => video);
  assert.equal(response.status, 416); assert.equal(response.headers.get('Content-Range'), 'bytes */8');
  const req = request(); req.headers.set('If-None-Match', '*');
  const full = await privateVideoResponse(req, async () => video);
  assert.equal(full.status, 200); assert.equal(full.headers.get('ETag'), null);
  assert.match(full.headers.get('Cache-Control')!, /private, no-store/); assert.equal(full.headers.get('Vary'), 'Cookie');
});
test('download is an explicit separate admission; playback permission alone is insufficient', async () => {
  const readOnly = async (download: boolean) => download ? null : video;
  assert.equal((await privateVideoResponse(request(), readOnly)).headers.get('Content-Disposition')?.startsWith('inline'), true);
  assert.equal((await privateVideoResponse(request('GET', undefined, '?download=1'), readOnly)).status, 404);
  const allowed = await privateVideoResponse(request('GET', undefined, '?download=1'), async () => video);
  assert.match(allowed.headers.get('Content-Disposition')!, /^attachment; filename\*=UTF-8''Formazione%20tecnica.mp4$/);
});
test('header injection and unsupported mutations fail closed', async () => {
  assert.equal((await privateVideoResponse(request(), async () => ({ ...video, fileName: 'video\r\nInjected: true' }))).status, 404);
  let called = false;
  const response = await privateVideoResponse(request('POST'), async () => { called = true; return video; });
  assert.equal(response.status, 405); assert.equal(called, false);
});
