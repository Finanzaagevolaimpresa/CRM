import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { probeFixture } from "./readiness.mjs";

const marker = "Contenuto commerciale raggiungibile";

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("headers without a completed body cannot stall readiness", { timeout: 2_000 }, async (t) => {
  let aborted;
  const disconnected = new Promise((resolve) => { aborted = resolve; });
  const url = await fixture(t, (request, response) => {
    request.on("close", aborted);
    response.writeHead(200, { "content-type": "text/html" });
    response.write("<html>still compiling");
  });
  assert.equal(await probeFixture(url, marker, { timeoutMs: 50 }), false);
  await disconnected;
});

test("no headers also expires", { timeout: 2_000 }, async (t) => {
  const url = await fixture(t, () => {});
  assert.equal(await probeFixture(url, marker, { timeoutMs: 50 }), false);
});

test("the marker spanning chunks succeeds without waiting for end", { timeout: 2_000 }, async (t) => {
  const url = await fixture(t, (_request, response) => {
    response.write(marker.slice(0, 12));
    setImmediate(() => response.write(marker.slice(12)));
  });
  assert.equal(await probeFixture(url, marker), true);
});

test("a complete page without the marker is not ready", async (t) => {
  const url = await fixture(t, (_request, response) => response.end("<html>wrong page</html>"));
  assert.equal(await probeFixture(url, marker), false);
});

test("an error page containing the marker is not ready", async (t) => {
  const url = await fixture(t, (_request, response) => { response.writeHead(500); response.end(marker); });
  assert.equal(await probeFixture(url, marker), false);
});

test("response size is bounded", async (t) => {
  const url = await fixture(t, (_request, response) => response.end("x".repeat(100) + marker));
  assert.equal(await probeFixture(url, marker, { maxBytes: 64 }), false);
});
