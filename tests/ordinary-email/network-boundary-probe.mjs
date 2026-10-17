import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
assert.equal(process.env.CI, 'true');
assert.equal(process.env.ORDINARY_EMAIL_BROWSER_CONFIRMED, '1');
const routes = (await readFile('/proc/net/route', 'utf8')).trim().split('\n').slice(1).map(line => line.trim().split(/\s+/));
assert.equal(routes.some(row => row[1] === '00000000' && row[7] === '00000000'), false);
const resolved = await lookup('authsmtp.securemail.pro');
const ownAddresses = Object.values(networkInterfaces()).flat().filter(Boolean).map(row => row.address);
assert.ok(ownAddresses.includes(resolved.address));
const proof = { synthetic: true, internalNetwork: true, applicationNetworks: 1,
  ipv4DefaultRoute: false, canonicalSmtpResolvesToOwnInterface: true, resolvedAddress: resolved.address };
await writeFile(process.env.ORDINARY_EMAIL_BROWSER_EVIDENCE + '/network-proof.json', JSON.stringify(proof));
console.log('ORDINARY_NETWORK_BOUNDARY ' + JSON.stringify(proof));
