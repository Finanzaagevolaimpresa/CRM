import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';

export function unitTestFiles(root) {
  const collect = (directory) => readdirSync(path.join(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => directory + '/' + entry.name).sort();
  return { native: collect('tests'), posix: collect('tests/posix') };
}

export function tapCounts(text) {
  const names = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const result = Object.fromEntries(names.map((name) => {
    const matches = [...text.matchAll(new RegExp('^# ' + name + ' (\\d+)\\r?$', 'gm'))];
    if (matches.length !== 1) throw new Error('UNIT_TAP_SUMMARY_INVALID:' + name);
    return [name, Number(matches[0][1])];
  }));
  if (result.tests < 1 || result.tests !== result.pass + result.fail + result.cancelled + result.skipped + result.todo) {
    throw new Error('UNIT_TAP_COUNTS_INVALID');
  }
  return result;
}

export function safeSnapshotPath(name) {
  if (typeof name !== 'string' || !name || /[\\:\0\r\n]/u.test(name)
      || name.startsWith('/') || name.split('/').some((part) => !part || part === '.' || part === '..')) return false;
  if (/^(?:src|scripts|tests|prisma|\.github)\//u.test(name)) {
    return !/(?:^|\/)(?:node_modules|\.git|\.env(?:\..*)?|CRM TXT\.txt|FAI-Custodia)(?:\/|$)/iu.test(name);
  }
  return /^(?:package(?:-lock)?\.json|tsconfig\.json|docker-compose[\w.-]*\.ya?ml|\.env(?:\.[\w-]+)?\.example)$/u.test(name);
}

export function canonicalSnapshotBytes(name, bytes) {
  return /\.(?:[cm]?[jt]sx?|json|ya?ml|sh|py|sql|prisma|md|example)$/u.test(name)
    ? Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n')) : bytes;
}

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function assertLocalLinuxDocker(context, info) {
  if (context.Name !== 'desktop-linux'
      || !/^npipe:\/\/[./]+pipe\/dockerDesktopLinuxEngine$/u.test(context.Endpoints?.docker?.Host ?? '')
      || info.OSType !== 'linux') throw new Error('UNIT_DOCKER_LOCAL_LINUX_REQUIRED');
}

export function posixRunArgs(image, files, cidFile) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(image) || !files.length
      || files.some((file) => !/^tests\/posix\/[\w.-]+\.test\.ts$/u.test(file))) {
    throw new Error('UNIT_POSIX_RUN_INPUT_INVALID');
  }
  return ['--context', 'desktop-linux', 'run', '--pull', 'never', '--network', 'none',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--user', '1000:1000', '--pids-limit', '256', '--memory', '2g', '--cpus', '2',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=536870912,mode=1777',
    '--tmpfs', '/home/node:rw,exec,nosuid,nodev,size=33554432,mode=0700,uid=1000,gid=1000',
    '--env', 'NODE_ENV=test', '--env', 'CI=true', '--env', 'HOME=/home/node',
    '--env', 'NEXT_TELEMETRY_DISABLED=1', '--env', 'GIT_TERMINAL_PROMPT=0',
    '--label', 'fai-crm.purpose=isolated-posix-unit-tests',
    ...(cidFile ? ['--cidfile', cidFile] : []),
    image, 'node', '--import', 'tsx', '--test', '--test-reporter=tap',
    '--test-concurrency=2', ...files];
}
