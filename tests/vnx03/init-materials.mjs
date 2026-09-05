import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';

if (process.env.VNX03_MATERIALS_CONFIRMED !== '1') {
  throw new Error('VNX03_MATERIALS_CONFIRMATION_MISSING');
}

const secretRoot = '/run/secrets';
const controlRoot = '/run/vnx03-control';
const evidenceRoot = '/run/vnx03-evidence';

for (const directory of [secretRoot, controlRoot, evidenceRoot]) {
  mkdirSync(directory, { recursive: true, mode: 0o755 });
}
if (readdirSync(secretRoot).length !== 0) {
  throw new Error('VNX03_SECRET_VOLUME_NOT_FRESH');
}

function writeOwned(path, data, mode, uid, gid) {
  writeFileSync(path, data, { mode, flag: 'wx' });
  chmodSync(path, mode);
  chownSync(path, uid, gid);
}

const gatewaySecret = randomBytes(32);
const invalidGatewaySecret = randomBytes(32);
const queueSecret = randomBytes(32);
const identitySecret = randomBytes(32);

writeOwned(
  `${secretRoot}/gateway-key.valid.b64`,
  `${gatewaySecret.toString('base64')}\n`,
  0o600,
  33,
  33,
);
writeOwned(
  `${secretRoot}/gateway-key.invalid.b64`,
  `${invalidGatewaySecret.toString('base64')}\n`,
  0o600,
  33,
  33,
);
writeOwned(
  `${secretRoot}/queue-key.b64`,
  `${queueSecret.toString('base64')}\n`,
  0o600,
  33,
  33,
);
writeOwned(
  `${secretRoot}/n12-keyring.json`,
  JSON.stringify({
    version: 1,
    keys: [{
      keyId: 'vnx03-wordpress-key-v1',
      secretBase64: gatewaySecret.toString('base64'),
    }],
  }),
  0o600,
  1001,
  1001,
);
writeOwned(
  `${secretRoot}/n13-identity.json`,
  JSON.stringify({ version: 1, secretBase64: identitySecret.toString('base64') }),
  0o600,
  1001,
  1001,
);

writeOwned(`${controlRoot}/connector-scenario`, 'disabled\n', 0o644, 33, 33);
writeOwned(`${controlRoot}/gateway-mode`, 'normal\n', 0o644, 1000, 1000);
chmodSync(evidenceRoot, 0o755);
chownSync(evidenceRoot, 1000, 1000);

gatewaySecret.fill(0);
invalidGatewaySecret.fill(0);
queueSecret.fill(0);
identitySecret.fill(0);

process.stdout.write('{"materials":"ready"}\n');
