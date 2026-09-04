import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, '..');
const pluginName = 'fai-secure-lead-connector';
const pluginRoot = path.join(repositoryRoot, 'integrations', 'wordpress', pluginName);
const mainFile = path.join(pluginRoot, `${pluginName}.php`);

function fail(code) {
  throw new Error(code);
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16LE(value);
  return output;
}

function uint32(value) {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value >>> 0);
  return output;
}

function filesBelow(directory, prefix = '') {
  const output = [];
  for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right, 'en'))) {
    if (name.includes('\0') || name === '.' || name === '..') fail('VNX02_PACKAGE_PATH_INVALID');
    const absolute = path.join(directory, name);
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) fail('VNX02_PACKAGE_SYMLINK_FORBIDDEN');
    if (stats.isDirectory()) output.push(...filesBelow(absolute, relative));
    else if (stats.isFile()) output.push({ absolute, relative });
    else fail('VNX02_PACKAGE_FILE_TYPE_INVALID');
  }
  return output;
}

export function buildPluginZip() {
  const main = readFileSync(mainFile, 'utf8');
  const match = main.match(/^ \* Version: (\d+\.\d+\.\d+)$/mu);
  if (!match) fail('VNX02_PACKAGE_VERSION_INVALID');
  const version = match[1];
  const files = filesBelow(pluginRoot);
  const names = new Set(files.map(({ relative }) => relative));
  for (const required of [`${pluginName}.php`, 'readme.txt', 'config.synthetic.example.php']) {
    if (!names.has(required)) fail('VNX02_PACKAGE_REQUIRED_FILE_MISSING');
  }
  if (files.some(({ relative }) => /(?:^|\/)(?:\.env|.*\.(?:key|pem|p12|pfx))$/iu.test(relative))) {
    fail('VNX02_PACKAGE_SECRET_FILE_FORBIDDEN');
  }
  const example = readFileSync(path.join(pluginRoot, 'config.synthetic.example.php'), 'utf8');
  if (!example.includes("'enabled' => false") || !example.includes('.synthetic.invalid')) {
    fail('VNX02_PACKAGE_EXAMPLE_NOT_DORMANT');
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const entryName = `${pluginName}/${file.relative}`;
    if (!/^[A-Za-z0-9._/-]+$/u.test(entryName) || entryName.includes('../')) {
      fail('VNX02_PACKAGE_PATH_INVALID');
    }
    const nameBytes = Buffer.from(entryName, 'utf8');
    const data = readFileSync(file.absolute);
    const checksum = crc32(data);
    const localHeader = Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0x0021),
      uint32(checksum),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      nameBytes,
    ]);
    localParts.push(localHeader, data);

    const centralHeader = Buffer.concat([
      uint32(0x02014b50),
      uint16(0x031e),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0x0021),
      uint32(checksum),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0x81a40000),
      uint32(offset),
      nameBytes,
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const body = Buffer.concat(localParts);
  const end = Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(files.length),
    uint16(files.length),
    uint32(central.length),
    uint32(body.length),
    uint16(0),
  ]);
  return {
    version,
    entries: files.map(({ relative }) => `${pluginName}/${relative}`),
    bytes: Buffer.concat([body, central, end]),
  };
}

function outputDirectoryFromArguments() {
  const option = process.argv.indexOf('--output');
  if (option === -1) return path.join(repositoryRoot, 'dist');
  const value = process.argv[option + 1];
  if (!value || process.argv.length !== option + 2) fail('VNX02_PACKAGE_ARGUMENT_INVALID');
  return path.resolve(value);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const artifact = buildPluginZip();
    const outputDirectory = outputDirectoryFromArguments();
    mkdirSync(outputDirectory, { recursive: true });
    const output = path.join(outputDirectory, `${pluginName}-${artifact.version}.zip`);
    writeFileSync(output, artifact.bytes, { flag: 'w', mode: 0o600 });
    const digest = createHash('sha256').update(artifact.bytes).digest('hex');
    process.stdout.write(`${output}\nsha256=${digest}\nentries=${artifact.entries.length}\n`);
  } catch {
    process.stderr.write('VNX02_PACKAGE_FAILED\n');
    process.exitCode = 1;
  }
}
