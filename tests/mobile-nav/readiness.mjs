import http from "node:http";

// The dev server may stream HTML without ending the response. Read only until
// the actual fixture marker arrives, with a deadline covering headers AND body.
export function probeFixture(url, marker, { timeoutMs = 2_000, maxBytes = 1_048_576 } = {}) {
  return new Promise((resolve) => {
    let request;
    let response;
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      response?.destroy();
      request?.destroy();
      resolve(ready);
    };
    const deadline = setTimeout(() => finish(false), timeoutMs);
    request = http.get(url, (incoming) => {
      response = incoming;
      if (incoming.statusCode !== 200) return finish(false);
      let body = "";
      let bytes = 0;
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) return finish(false);
        body += chunk;
        if (body.includes(marker)) finish(true);
      });
      incoming.on("end", () => finish(false));
      incoming.on("error", () => finish(false));
      incoming.on("aborted", () => finish(false));
    });
    request.on("error", () => finish(false));
  });
}
