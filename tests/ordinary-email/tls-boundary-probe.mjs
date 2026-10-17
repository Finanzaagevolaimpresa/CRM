import assert from 'node:assert/strict';
import tls from 'node:tls';
import { readFile, writeFile } from 'node:fs/promises';
assert.equal(process.env.CI, 'true');
assert.equal(process.env.ORDINARY_EMAIL_BROWSER_CONFIRMED, '1');
const host = 'authsmtp.securemail.pro';
function probe(options) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 465, servername: host, rejectUnauthorized: true, minVersion: 'TLSv1.2', ...options });
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('TIMEOUT')); });
    socket.once('secureConnect', () => {
      const result = { authorized: socket.authorized, protocol: socket.getProtocol(), remoteAddress: socket.remoteAddress };
      socket.destroy(); resolve(result);
    });
    socket.once('error', error => { socket.destroy(); reject(error); });
  });
}
const trusted = await probe({});
assert.equal(trusted.authorized, true);
assert.ok(['TLSv1.2','TLSv1.3'].includes(trusted.protocol));
assert.ok(trusted.remoteAddress);
await assert.rejects(probe({ servername: 'wrong.invalid' }), error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
// Explicit unrelated trust store overrides NODE_EXTRA_CA_CERTS for this negative probe.
const unrelated = await readFile('/run/ordinary-secrets/unrelated.crt');
await assert.rejects(probe({ ca: unrelated }), error => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));
const proof = { synthetic: true, nativeTls: true, trusted: true, wrongServernameDenied: true, untrustedIssuerDenied: true,
  protocol: trusted.protocol, localContainerAddress: trusted.remoteAddress, credentialsSubmitted: false };
await writeFile(process.env.ORDINARY_EMAIL_BROWSER_EVIDENCE + '/tls-boundary-proof.json', JSON.stringify(proof));
console.log('ORDINARY_TLS_BOUNDARY ' + JSON.stringify(proof));
