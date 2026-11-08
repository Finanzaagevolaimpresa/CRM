import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalLinuxDocker, canonicalSnapshotBytes, posixRunArgs, safeSnapshotPath, sha256, tapCounts, unitTestFiles } from './unit-test-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const evidenceIndex = args.indexOf('--evidence-dir');
const evidenceArg = evidenceIndex >= 0 ? args[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0) args.splice(evidenceIndex, 2);
if (args.length || (evidenceIndex >= 0 && !evidenceArg)) throw new Error('Usage: npm test -- [--evidence-dir ABSOLUTE_NEW_DIRECTORY]');
if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('UNIT_NODE_22_REQUIRED: use the version in .nvmrc');
const evidence = evidenceArg ? path.resolve(evidenceArg) : mkdtempSync(path.join(tmpdir(), 'fai-unit-evidence-'));
if (evidenceArg) mkdirSync(evidence, { recursive: false });
const record = { startedAt: new Date().toISOString(), platform: process.platform, node: process.version, cwd: root, phases: [] };
const save = () => writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(record, null, 2) + '\n');
const git = (...gitArgs) => {
  const result = spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('UNIT_GIT_FAILED:' + gitArgs[0]);
  return result.stdout;
};
record.head = git('rev-parse', 'HEAD').trim();
record.diffSha256 = sha256(Buffer.from(git('diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--binary')));
const files = unitTestFiles(root);
if (!files.native.length || !files.posix.length) throw new Error('UNIT_TEST_DISCOVERY_EMPTY');
record.files = files;

async function run(name, executable, commandArgs, timeoutMs, summarize = false) {
  const phase = { name, executable, args: commandArgs, startedAt: new Date().toISOString() };
  record.phases.push(phase); save();
  const stdoutPath = path.join(evidence, name + '.stdout.log');
  const stderrPath = path.join(evidence, name + '.stderr.log');
  const stdout = createWriteStream(stdoutPath, { flags: 'wx' });
  const stderr = createWriteStream(stderrPath, { flags: 'wx' });
  const started = Date.now();
  const child = spawn(executable, commandArgs, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  child.stdout.on('data', (data) => process.stdout.write(data));
  child.stderr.on('data', (data) => process.stderr.write(data));
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  const timer = setTimeout(() => { phase.timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const outcome = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  await Promise.all([finished(stdout), finished(stderr)]);
  Object.assign(phase, outcome, { durationMs: Date.now() - started,
    stdout: { path: stdoutPath, sha256: sha256(readFileSync(stdoutPath)) },
    stderr: { path: stderrPath, sha256: sha256(readFileSync(stderrPath)) } });
  if (spawnError) phase.errorCode = spawnError.code;
  if (summarize) {
    try { phase.counts = tapCounts(readFileSync(stdoutPath, 'utf8')); }
    catch (error) { phase.summaryError = error.message; }
  }
  phase.pass = !spawnError && !phase.timedOut && outcome.code === 0 && outcome.signal === null
    && (!summarize || (phase.counts && phase.counts.fail === 0 && phase.counts.cancelled === 0));
  save();
  return phase;
}

function dockerJson(commandArgs) {
  const result = spawnSync('docker', ['--context', 'desktop-linux', ...commandArgs],
    { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('UNIT_DOCKER_PREFLIGHT_FAILED:' + commandArgs[0]);
  return JSON.parse(result.stdout);
}

function snapshot() {
  // Enumerate only tracked source paths. No .git, private storage, untracked files,
  // real .env, host configuration, credentials or Docker socket enter the image.
  const entries = git('ls-files', '--stage', '-z', '--', 'src', 'scripts', 'tests', 'prisma', '.github',
    'package.json', 'package-lock.json', 'tsconfig.json', 'docker-compose*.yml', '.env*.example').split('\0').filter(Boolean);
  const context = mkdtempSync(path.join(tmpdir(), 'fai-posix-source-'));
  const manifest = [];
  let total = 0;
  for (const entry of entries) {
    const match = /^(\d{6}) [a-f0-9]+ (\d)\t([\s\S]+)$/u.exec(entry);
    if (!match || match[2] !== '0') throw new Error('UNIT_UNMERGED_SOURCE');
    const [, mode, , name] = match;
    if (!safeSnapshotPath(name) || !['100644', '100755'].includes(mode)) throw new Error('UNIT_UNSAFE_SOURCE_PATH:' + name);
    const source = path.join(root, name);
    if (!existsSync(source)) continue; // tracked deletion in the current diff
    // Reject links in every path component, including Windows junctions.
    let ancestor = root;
    for (const part of name.split('/')) {
      ancestor = path.join(ancestor, part);
      if (lstatSync(ancestor).isSymbolicLink()) throw new Error('UNIT_LINKED_SOURCE:' + name);
    }
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('UNIT_SOURCE_FILE_INVALID:' + name);
    total += stat.size;
    if (total > 256 * 1024 * 1024) throw new Error('UNIT_SOURCE_SIZE_EXCEEDED');
    const original = readFileSync(source);
    const bytes = canonicalSnapshotBytes(name, original);
    const destination = path.join(context, 'snapshot', name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: 'wx' });
    manifest.push({ name, mode, originalSha256: sha256(original), sha256: sha256(bytes), bytes: bytes.length });
  }
  for (const file of [...files.native, ...files.posix]) {
    if (!manifest.some((entry) => entry.name === file)) throw new Error('UNIT_TEST_NOT_STAGED:' + file);
  }
  for (const file of ['package.json', 'package-lock.json', 'prisma/schema.prisma']) {
    if (!manifest.some((entry) => entry.name === file)) throw new Error('UNIT_SOURCE_REQUIRED:' + file);
  }
  writeFileSync(path.join(context, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(path.join(context, 'Dockerfile'), [
    'FROM node:22-bookworm',
    'WORKDIR /workspace',
    'RUN node --version && python3 --version && git --version && bash --version',
    'COPY snapshot/package.json snapshot/package-lock.json ./',
    'COPY snapshot/prisma/schema.prisma ./prisma/schema.prisma',
    'RUN npm ci --no-audit --no-fund && npx prisma generate',
    'COPY snapshot/ ./',
    'COPY manifest.json /tmp/unit-source-manifest.json',
    'RUN node -e "const fs=require(\'node:fs\'); for(const x of JSON.parse(fs.readFileSync(\'/tmp/unit-source-manifest.json\'))) fs.chmodSync(x.name,x.mode===\'100755\'?0o755:0o644)"',
    'USER node',
    '',
  ].join('\n'));
  record.snapshot = { context, manifestPath: path.join(evidence, 'source-manifest.json'), files: manifest.length, totalBytes: total,
    sha256: sha256(Buffer.from(JSON.stringify(manifest))), lineEndings: 'canonical LF for tracked text; original hashes retained' };
  writeFileSync(record.snapshot.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  save();
  return { context, manifest };
}

try {
  if (process.platform !== 'win32') {
    await run('native-posix', process.execPath,
      ['--import', 'tsx', '--test', '--test-reporter=tap', ...files.native, ...files.posix], 15 * 60_000, true);
  } else {
    const captured = snapshot();
    // Both phases are mandatory. A failed native phase does not suppress POSIX diagnostics.
    await run('windows-native', process.execPath,
      ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=4', ...files.native], 15 * 60_000, true);
    const context = dockerJson(['context', 'inspect', 'desktop-linux'])[0];
    const info = dockerJson(['info', '--format', '{{json .}}']);
    assertLocalLinuxDocker(context, info);
    const base = dockerJson(['image', 'inspect', 'node:22-bookworm'])[0];
    record.docker = { context: context.Name, endpoint: context.Endpoints.docker.Host, os: info.OSType,
      serverVersion: info.ServerVersion, baseImage: base.Id };
    const imageFile = path.join(evidence, 'posix-image.id');
    const build = await run('posix-image-build', 'docker',
      ['--context', 'desktop-linux', 'build', '--pull=false', '--iidfile', imageFile, captured.context], 15 * 60_000);
    if (!build.pass) throw new Error('UNIT_POSIX_IMAGE_BUILD_FAILED');
    const image = readFileSync(imageFile, 'utf8').trim();
    record.docker.image = image;
    const cidFile = path.join(evidence, 'posix-container.id');
    const posix = await run('linux-posix-contracts', 'docker', posixRunArgs(image, files.posix, cidFile), 5 * 60_000, true);
    if (posix.counts?.skipped !== 0 || posix.counts?.todo !== 0) posix.pass = false;
    if (existsSync(cidFile)) {
      const cid = readFileSync(cidFile, 'utf8').trim();
      if (!/^[a-f0-9]{64}$/u.test(cid)) throw new Error('UNIT_CONTAINER_ID_INVALID');
      const container = dockerJson(['inspect', cid])[0];
      if (container.Config.Image !== image || container.Config.Labels?.['fai-crm.purpose'] !== 'isolated-posix-unit-tests') {
        throw new Error('UNIT_CONTAINER_IDENTITY_MISMATCH');
      }
      record.docker.container = { id: cid, image: container.Image, running: container.State.Running,
        exit: container.State.ExitCode, network: container.HostConfig.NetworkMode,
        readOnly: container.HostConfig.ReadonlyRootfs, mounts: container.Mounts.map(({ Type, Destination }) => ({ Type, Destination })) };
      if (container.State.Running) {
        posix.pass = false;
        await run('stop-owned-timed-out-container', 'docker', ['--context', 'desktop-linux', 'stop', '--time', '10', cid], 30_000);
      }
    }
    for (const file of captured.manifest) {
      if (sha256(readFileSync(path.join(root, file.name))) !== file.originalSha256) throw new Error('UNIT_SOURCE_CHANGED:' + file.name);
    }
  }
  if (git('rev-parse', 'HEAD').trim() !== record.head
      || sha256(Buffer.from(git('diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--binary'))) !== record.diffSha256) {
    throw new Error('UNIT_CANDIDATE_CHANGED');
  }
  record.complete = record.phases.every((phase) => phase.pass);
} catch (error) {
  record.complete = false;
  record.error = error.message;
  process.stderr.write(error.message + '\n');
} finally {
  record.finishedAt = new Date().toISOString();
  const testPhases = record.phases.filter((phase) => phase.counts);
  record.counts = testPhases.reduce((total, phase) => {
    for (const [key, value] of Object.entries(phase.counts)) total[key] = (total[key] ?? 0) + value;
    return total;
  }, {});
  save();
  process.stdout.write('\nUNIT_EVIDENCE=' + evidence + '\nUNIT_COMPLETE=' + record.complete + '\n');
  process.exitCode = record.complete ? 0 : 1;
}
